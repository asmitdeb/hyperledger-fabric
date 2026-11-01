'use strict';

const { z } = require('zod');
const { StateGraph, Annotation, START, END } = require('@langchain/langgraph');
const { ChatOllama } = require('@langchain/ollama');
const { encrypt } = require('../healthcare-offchain/cryptoService');
const FabricBridge = require('./fabricBridge');

/**
 * Node 1 Grammar-Constrained Schema (Zod -> GBNF in Ollama)
 * Prevents any syntax error or broken JSON from small local models (like llama3.2:3b).
 */
const IntentClassificationSchema = z.object({
    intent: z.enum([
        'READ_PATIENT_RECORD',
        'GET_PATIENT_HISTORY',
        'VERIFY_INTEGRITY',
        'GRANT_ACCESS',
        'REVOKE_ACCESS',
        'UPDATE_ROOM_NUMBER',
        'UPDATE_MEDICAL_CONDITION',
        'UPDATE_MEDICATION',
        'UPDATE_TEST_RESULTS',
        'UPDATE_BILLING_AMOUNT',
        'UPDATE_DISCHARGE_DATE',
        'SEARCH_AND_AGGREGATE',
        'LIST_PATIENTS',
        'EXPLAIN_ARCHITECTURE'
    ]).describe('The primary blockchain transaction or query intent matching the user request'),
    patientId: z.string().nullable().describe('Patient ID such as PID-000001, or null if not mentioned'),
    patientName: z.string().nullable().describe('Patient full or first name if mentioned instead of ID, or null'),
    targetOrg: z.enum([
        'HospitalAMSP',
        'HospitalBMSP',
        'HospitalCMSP',
        'InsuranceOrgMSP',
        'NONE'
    ]).describe('Target organization MSP for access control or hospital filtering, or NONE'),
    accessType: z.enum([
        'READ',
        'WRITE',
        'BILLING_READ',
        'BILLING_WRITE',
        'ADMIN',
        'NONE'
    ]).describe('Permission level to grant or check, or NONE'),
    newValue: z.string().nullable().describe('New value when updating room number, medical condition, medication, test results, billing amount, or discharge date, or null'),
    conditionFilter: z.string().nullable().describe('Medical condition filter for clinical search (e.g. Cancer, Asthma, Diabetes, Hypertension, Arthritis, Obesity), or null'),
    bloodTypeFilter: z.string().nullable().describe('Blood type filter (e.g. A+, B-, O+), or null'),
    genderFilter: z.string().nullable().describe('Gender filter (Male or Female), or null')
});

/**
 * LangGraph State Definition
 */
const GraphState = Annotation.Root({
    prompt: Annotation({ reducer: (x, y) => y ?? x, default: () => '' }),
    callerOrg: Annotation({ reducer: (x, y) => y ?? x, default: () => 'HospitalAMSP' }),
    ollamaUsed: Annotation({ reducer: (x, y) => y ?? x, default: () => false }),
    extractedIntent: Annotation({ reducer: (x, y) => y ?? x, default: () => null }),
    transactionProposal: Annotation({ reducer: (x, y) => y ?? x, default: () => null }),
    executedTools: Annotation({ reducer: (x, y) => y ?? x, default: () => [] }),
    executionResult: Annotation({ reducer: (x, y) => y ?? x, default: () => null }),
    response: Annotation({ reducer: (x, y) => y ?? x, default: () => '' })
});

/**
 * AI Engine for Healthcare Hyperledger Fabric Dashboard powered by LangGraph.
 *
 * Uses:
 * 1. Node 1 (`extract_intent`): Grammar-Constrained Structured Output (`withStructuredOutput(IntentClassificationSchema)`)
 *    with deterministic entity cross-verification so JSON never breaks.
 * 2. Node 2 (`build_proposal`): Deterministic JavaScript Hyperledger Fabric Transaction Proposal Builder
 *    (never lets the LLM write raw transaction proposal JSON).
 * 3. Node 3 (`execute_transaction`): Executes the validated proposal against the ledger & encrypted LevelDB.
 */
class FabricAiEngine {
    /**
     * @param {Object} options
     * @param {Map} options.onChainLedger - On-chain ledger state mirror
     * @param {Map} options.auditHistory - Immutable ledger history mirror
     * @param {LevelDbStore} options.store - Off-chain encrypted LevelDB store
     * @param {Function} options.sha256 - SHA-256 hash function
     * @param {string} [options.ollamaUrl] - Ollama endpoint (default: http://127.0.0.1:11434)
     * @param {string} [options.model] - Model name (default: llama3.2:3b)
     */
    constructor(options) {
        this.onChainLedger = options.onChainLedger;
        this.auditHistory = options.auditHistory;
        this.store = options.store;
        this.sha256 = options.sha256;
        this.ollamaUrl = options.ollamaUrl || 'http://127.0.0.1:11434';
        this.model = options.model || 'llama3.2:3b';

        this.workflow = this._buildLangGraph();
    }

    /**
     * Check if Ollama server is reachable locally
     * @returns {Promise<boolean>}
     */
    async isOllamaAvailable() {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1200);
            const res = await fetch(`${this.ollamaUrl}/api/tags`, { signal: controller.signal });
            clearTimeout(timeoutId);
            return res.ok;
        } catch (e) {
            return false;
        }
    }

    // =========================================================================
    // LangGraph Pipeline Construction (Nodes 1, 2, and 3)
    // =========================================================================

    _buildLangGraph() {
        const graph = new StateGraph(GraphState)
            .addNode('extract_intent', this._nodeExtractIntent.bind(this))
            .addNode('build_proposal', this._nodeBuildProposal.bind(this))
            .addNode('execute_transaction', this._nodeExecuteTransaction.bind(this))
            .addEdge(START, 'extract_intent')
            .addEdge('extract_intent', 'build_proposal')
            .addEdge('build_proposal', 'execute_transaction')
            .addEdge('execute_transaction', END);

        return graph.compile();
    }

    /**
     * NODE 1: Grammar-Constrained Structured Intent & Entity Extractor
     * Uses ChatOllama.withStructuredOutput(IntentClassificationSchema) + deterministic cross-check.
     */
    async _nodeExtractIntent(state) {
        const { prompt } = state;
        const deterministic = this.extractDeterministicEntities(prompt);
        let llmParsed = null;
        let ollamaUsed = false;

        if (await this.isOllamaAvailable()) {
            try {
                const llm = new ChatOllama({
                    baseUrl: this.ollamaUrl,
                    model: this.model,
                    temperature: 0
                });

                const structuredLlm = llm.withStructuredOutput(IntentClassificationSchema, {
                    name: 'classify_fabric_intent'
                });

                const systemPrompt = [
                    'You are a strict intent classifier for a Hyperledger Fabric Healthcare blockchain.',
                    'Classify the user request into the exact schema fields.',
                    '- Use GRANT_ACCESS when granting/giving/allowing access permissions.',
                    '- Use REVOKE_ACCESS when revoking/removing access permissions.',
                    '- Use UPDATE_ROOM_NUMBER, UPDATE_MEDICAL_CONDITION, UPDATE_MEDICATION, UPDATE_TEST_RESULTS, UPDATE_BILLING_AMOUNT, or UPDATE_DISCHARGE_DATE when modifying those patient fields.',
                    '- Use GET_PATIENT_HISTORY for audit trail, history, provenance, or timeline queries.',
                    '- Use VERIFY_INTEGRITY for hash verification, tamper checks, or authenticity checks.',
                    '- Use SEARCH_AND_AGGREGATE when counting/filtering patients by condition, blood type, gender, or hospital.',
                    '- Use LIST_PATIENTS when listing all patients or registry overview.',
                    '- Use EXPLAIN_ARCHITECTURE when explaining how privacy, LevelDB, or Fabric architecture works.',
                    '- Use READ_PATIENT_RECORD for looking up a specific patient record or clinical details.'
                ].join('\n');

                llmParsed = await structuredLlm.invoke([
                    ['system', systemPrompt],
                    ['human', prompt]
                ]);
                ollamaUsed = true;
            } catch (err) {
                console.warn('[LangGraph Node 1] Ollama structured extraction fallback:', err.message);
            }
        }

        // Merge LLM structured output with deterministic entity verification so small models never miss explicit IDs/enums
        const mergedIntent = {
            intent: deterministic.explicitIntent || (llmParsed && llmParsed.intent) || 'READ_PATIENT_RECORD',
            patientId: deterministic.patientId || (llmParsed && llmParsed.patientId ? this.normalizePatientId(llmParsed.patientId) : null),
            targetOrg: deterministic.targetOrg || (llmParsed && llmParsed.targetOrg !== 'NONE' ? llmParsed.targetOrg : null),
            accessType: deterministic.accessType || (llmParsed && llmParsed.accessType !== 'NONE' ? llmParsed.accessType : null),
            newValue: deterministic.newValue || (llmParsed && llmParsed.newValue ? String(llmParsed.newValue).trim() : null),
            conditionFilter: deterministic.conditionFilter || (llmParsed && llmParsed.conditionFilter ? llmParsed.conditionFilter.toLowerCase() : null),
            bloodTypeFilter: deterministic.bloodTypeFilter || (llmParsed && llmParsed.bloodTypeFilter ? llmParsed.bloodTypeFilter.toUpperCase() : null),
            genderFilter: deterministic.genderFilter || (llmParsed && llmParsed.genderFilter ? llmParsed.genderFilter.toLowerCase() : null),
            hospitalFilter: deterministic.hospitalFilter || null
        };

        // If LLM extracted a patientName and patientId is still null, resolve name -> PID
        if (!mergedIntent.patientId && llmParsed && llmParsed.patientName) {
            mergedIntent.patientId = this.findPatientIdByName(llmParsed.patientName);
        }

        return {
            ollamaUsed,
            extractedIntent: mergedIntent
        };
    }

    /**
     * NODE 2: Deterministic Hyperledger Fabric Transaction Proposal Builder
     * Pure JavaScript constructs the exact Fabric chaincode invocation payload so JSON syntax is 100% valid.
     */
    async _nodeBuildProposal(state) {
        const { extractedIntent, callerOrg } = state;
        const intent = extractedIntent.intent;
        const pid = extractedIntent.patientId || 'PID-000001';

        const baseProposal = {
            channelId: 'healthcare-channel',
            chaincodeName: 'healthcare-contract',
            callerMspId: callerOrg,
            timestamp: new Date().toISOString()
        };

        let proposal = null;
        const executedTools = [];

        switch (intent) {
            case 'GRANT_ACCESS': {
                const targetOrg = this.normalizeOrgName(extractedIntent.targetOrg || 'HospitalBMSP');
                const accessType = (extractedIntent.accessType || 'READ').toUpperCase();
                proposal = {
                    ...baseProposal,
                    txType: 'INVOKE_TRANSACTION',
                    fcn: 'GrantAccess',
                    args: [extractedIntent.patientId, targetOrg, accessType],
                    argsMap: { patientId: extractedIntent.patientId, targetOrg, accessType }
                };
                if (extractedIntent.patientId) {
                    executedTools.push({
                        name: 'GrantAccess',
                        args: {
                            channel: 'healthcare-channel',
                            chaincode: 'healthcare-contract',
                            fcn: 'GrantAccess',
                            args: [extractedIntent.patientId, targetOrg, accessType]
                        }
                    });
                }
                break;
            }

            case 'REVOKE_ACCESS': {
                const targetOrg = this.normalizeOrgName(extractedIntent.targetOrg || 'HospitalBMSP');
                proposal = {
                    ...baseProposal,
                    txType: 'INVOKE_TRANSACTION',
                    fcn: 'RevokeAccess',
                    args: [extractedIntent.patientId, targetOrg],
                    argsMap: { patientId: extractedIntent.patientId, targetOrg }
                };
                if (extractedIntent.patientId) {
                    executedTools.push({
                        name: 'RevokeAccess',
                        args: {
                            channel: 'healthcare-channel',
                            chaincode: 'healthcare-contract',
                            fcn: 'RevokeAccess',
                            args: [extractedIntent.patientId, targetOrg]
                        }
                    });
                }
                break;
            }

            case 'UPDATE_ROOM_NUMBER': {
                const roomNumber = extractedIntent.newValue || '101-A';
                proposal = {
                    ...baseProposal,
                    txType: 'INVOKE_TRANSACTION',
                    fcn: 'UpdateRoomNumber',
                    args: [pid, roomNumber],
                    argsMap: { patientId: pid, roomNumber }
                };
                executedTools.push({
                    name: 'UpdateRoomNumber',
                    args: {
                        channel: 'healthcare-channel',
                        chaincode: 'healthcare-contract',
                        fcn: 'UpdateRoomNumber',
                        args: [pid, roomNumber]
                    }
                });
                break;
            }

            case 'UPDATE_MEDICAL_CONDITION': {
                const newCondition = extractedIntent.newValue || 'Hypertension';
                const newConditionHash = this.sha256(newCondition);
                proposal = {
                    ...baseProposal,
                    txType: 'INVOKE_TRANSACTION',
                    fcn: 'UpdateMedicalCondition',
                    args: [pid, newConditionHash],
                    argsMap: { patientId: pid, newCondition, newConditionHash }
                };
                executedTools.push({
                    name: 'UpdateMedicalCondition',
                    args: {
                        channel: 'healthcare-channel',
                        chaincode: 'healthcare-contract',
                        fcn: 'UpdateMedicalCondition',
                        args: [pid, newConditionHash]
                    }
                });
                break;
            }

            case 'UPDATE_MEDICATION': {
                const newMedication = extractedIntent.newValue || 'Lisinopril';
                const newMedicationHash = this.sha256(newMedication);
                proposal = {
                    ...baseProposal,
                    txType: 'INVOKE_TRANSACTION',
                    fcn: 'UpdateMedication',
                    args: [pid, newMedicationHash],
                    argsMap: { patientId: pid, newMedication, newMedicationHash }
                };
                executedTools.push({
                    name: 'UpdateMedication',
                    args: {
                        channel: 'healthcare-channel',
                        chaincode: 'healthcare-contract',
                        fcn: 'UpdateMedication',
                        args: [pid, newMedicationHash]
                    }
                });
                break;
            }

            case 'UPDATE_TEST_RESULTS': {
                const newTestResults = extractedIntent.newValue || 'Normal';
                const newTestResultsHash = this.sha256(newTestResults);
                proposal = {
                    ...baseProposal,
                    txType: 'INVOKE_TRANSACTION',
                    fcn: 'UpdateTestResults',
                    args: [pid, newTestResultsHash],
                    argsMap: { patientId: pid, newTestResults, newTestResultsHash }
                };
                executedTools.push({
                    name: 'UpdateTestResults',
                    args: {
                        channel: 'healthcare-channel',
                        chaincode: 'healthcare-contract',
                        fcn: 'UpdateTestResults',
                        args: [pid, newTestResultsHash]
                    }
                });
                break;
            }

            case 'UPDATE_BILLING_AMOUNT': {
                const newBillingAmount = String(extractedIntent.newValue || '15000.00').replace(/[^0-9.]/g, '');
                const newBillingHash = this.sha256(newBillingAmount);
                proposal = {
                    ...baseProposal,
                    txType: 'INVOKE_TRANSACTION',
                    fcn: 'UpdateBillingAmount',
                    args: [pid, newBillingHash],
                    argsMap: { patientId: pid, newBillingAmount, newBillingHash }
                };
                executedTools.push({
                    name: 'UpdateBillingAmount',
                    args: {
                        channel: 'healthcare-channel',
                        chaincode: 'healthcare-contract',
                        fcn: 'UpdateBillingAmount',
                        args: [pid, newBillingHash]
                    }
                });
                break;
            }

            case 'UPDATE_DISCHARGE_DATE': {
                const dischargeDate = extractedIntent.newValue || new Date().toISOString().substring(0, 10);
                proposal = {
                    ...baseProposal,
                    txType: 'INVOKE_TRANSACTION',
                    fcn: 'UpdateDischargeDate',
                    args: [pid, dischargeDate],
                    argsMap: { patientId: pid, dischargeDate }
                };
                executedTools.push({
                    name: 'UpdateDischargeDate',
                    args: {
                        channel: 'healthcare-channel',
                        chaincode: 'healthcare-contract',
                        fcn: 'UpdateDischargeDate',
                        args: [pid, dischargeDate]
                    }
                });
                break;
            }

            case 'GET_PATIENT_HISTORY': {
                proposal = {
                    ...baseProposal,
                    txType: 'QUERY_LEDGER',
                    fcn: 'GetPatientHistory',
                    args: [pid],
                    argsMap: { patientId: pid }
                };
                executedTools.push({
                    name: 'GetPatientHistory',
                    args: {
                        channel: 'healthcare-channel',
                        chaincode: 'healthcare-contract',
                        fcn: 'GetPatientHistory',
                        args: [pid]
                    }
                });
                break;
            }

            case 'VERIFY_INTEGRITY': {
                proposal = {
                    ...baseProposal,
                    txType: 'QUERY_AND_VERIFY_HASH',
                    fcn: 'ReadPatientRecord',
                    args: [pid],
                    argsMap: { patientId: pid }
                };
                executedTools.push({
                    name: 'VerifyIntegrity',
                    args: {
                        channel: 'healthcare-channel',
                        chaincode: 'healthcare-contract',
                        fcn: 'ReadPatientRecord',
                        args: [pid]
                    }
                });
                break;
            }

            case 'SEARCH_AND_AGGREGATE': {
                const filters = {};
                if (extractedIntent.conditionFilter) filters.condition = extractedIntent.conditionFilter;
                if (extractedIntent.bloodTypeFilter) filters.bloodType = extractedIntent.bloodTypeFilter;
                if (extractedIntent.genderFilter) filters.gender = extractedIntent.genderFilter;
                if (extractedIntent.hospitalFilter) filters.hospital = extractedIntent.hospitalFilter;

                proposal = {
                    ...baseProposal,
                    txType: 'QUERY_COMPOSITE',
                    fcn: 'SearchAndAggregate',
                    args: [JSON.stringify(filters)],
                    argsMap: filters
                };
                executedTools.push({
                    name: 'SearchAndAggregate',
                    args: filters
                });
                break;
            }

            case 'LIST_PATIENTS': {
                proposal = {
                    ...baseProposal,
                    txType: 'QUERY_LEDGER',
                    fcn: 'ListPatients',
                    args: [],
                    argsMap: {}
                };
                executedTools.push({
                    name: 'ListPatients',
                    args: { channel: 'healthcare-channel', chaincode: 'healthcare-contract' }
                });
                break;
            }

            case 'EXPLAIN_ARCHITECTURE': {
                proposal = {
                    ...baseProposal,
                    txType: 'INFORMATIONAL',
                    fcn: 'ExplainArchitecture',
                    args: [],
                    argsMap: {}
                };
                executedTools.push({
                    name: 'ExplainArchitecture',
                    args: {}
                });
                break;
            }

            case 'READ_PATIENT_RECORD':
            default: {
                proposal = {
                    ...baseProposal,
                    txType: 'QUERY_LEDGER',
                    fcn: 'ReadPatientRecord',
                    args: [pid],
                    argsMap: { patientId: pid }
                };
                executedTools.push({
                    name: 'ReadPatientRecord',
                    args: {
                        channel: 'healthcare-channel',
                        chaincode: 'healthcare-contract',
                        fcn: 'ReadPatientRecord',
                        args: [pid]
                    }
                });
                break;
            }
        }

        return {
            transactionProposal: proposal,
            executedTools
        };
    }

    /**
     * NODE 3: Deterministic Chaincode & Off-Chain Execution + Markdown Response Synthesizer
     */
    async _nodeExecuteTransaction(state) {
        const { extractedIntent, transactionProposal, callerOrg } = state;
        const intent = extractedIntent.intent;
        const argsMap = transactionProposal.argsMap || {};

        // Format deterministic transaction proposal block for output transparency
        const proposalJsonBlock = '```json\n' + JSON.stringify({
            channelId: transactionProposal.channelId,
            chaincodeName: transactionProposal.chaincodeName,
            fcn: transactionProposal.fcn,
            args: transactionProposal.args,
            callerMspId: transactionProposal.callerMspId
        }, null, 2) + '\n```';

        // 1. GRANT_ACCESS
        if (intent === 'GRANT_ACCESS') {
            if (!argsMap.patientId) {
                return {
                    response: `⚠️ **Action Needed**: Please specify which patient record you want to grant access for (e.g. *PID-000001*).`
                };
            }
            const grantRes = await this.toolGrantAccess(argsMap.patientId, argsMap.targetOrg, argsMap.accessType, callerOrg);
            if (!grantRes.success) {
                return { response: `❌ **Failed to Grant Access**: ${grantRes.error}` };
            }

            return {
                executionResult: grantRes,
                response: `### 🔐 Access Permission Granted Successfully\n\n` +
                    `- **Patient ID**: \`${grantRes.patientId}\`\n` +
                    `- **Target Organization**: **${grantRes.targetOrg}**\n` +
                    `- **Permission Level**: \`${grantRes.accessType}\`\n` +
                    `- **Granted By**: \`${callerOrg}\`\n` +
                    `- **Transaction ID**: \`${grantRes.txId}\`\n` +
                    `- **Timestamp**: ${grantRes.timestamp}\n\n` +
                    `#### 📋 Executed Fabric Transaction Proposal\n${proposalJsonBlock}\n\n` +
                    `The Hyperledger Fabric ledger state and access control matrix have been updated.`
            };
        }

        // 2. REVOKE_ACCESS
        if (intent === 'REVOKE_ACCESS') {
            if (!argsMap.patientId) {
                return {
                    response: `⚠️ **Action Needed**: Please specify which patient record you want to revoke access from (e.g. *PID-000001*).`
                };
            }
            const revokeRes = await this.toolRevokeAccess(argsMap.patientId, argsMap.targetOrg, callerOrg);
            if (!revokeRes.success) {
                return { response: `❌ **Failed to Revoke Access**: ${revokeRes.error}` };
            }

            return {
                executionResult: revokeRes,
                response: `### 🚫 Access Revoked\n\n` +
                    `- **Patient ID**: \`${revokeRes.patientId}\`\n` +
                    `- **Revoked Organization**: **${revokeRes.targetOrg}**\n` +
                    `- **Transaction ID**: \`${revokeRes.txId}\`\n` +
                    `- **Timestamp**: ${revokeRes.timestamp}\n\n` +
                    `#### 📋 Executed Fabric Transaction Proposal\n${proposalJsonBlock}\n\n` +
                    `Access rights for **${revokeRes.targetOrg}** have been removed from the on-chain access policy.`
            };
        }

        // 3. CLINICAL & HOSPITAL FIELD UPDATES
        if ([
            'UPDATE_ROOM_NUMBER',
            'UPDATE_MEDICAL_CONDITION',
            'UPDATE_MEDICATION',
            'UPDATE_TEST_RESULTS',
            'UPDATE_BILLING_AMOUNT',
            'UPDATE_DISCHARGE_DATE'
        ].includes(intent)) {
            const updateRes = await this.toolUpdatePatientField(
                argsMap.patientId,
                transactionProposal.fcn,
                argsMap,
                callerOrg
            );

            if (!updateRes.success) {
                return { response: `❌ **Transaction Rejected**: ${updateRes.error}` };
            }

            return {
                executionResult: updateRes,
                response: `### ✅ Ledger Transaction Committed: \`${transactionProposal.fcn}\`\n\n` +
                    `- **Patient ID**: \`${updateRes.patientId}\` (${updateRes.patientName})\n` +
                    `- **Updated Field**: **${updateRes.fieldLabel}** → \`${updateRes.displayValue}\`\n` +
                    `- **Updated Root SHA-256 Hash**: \`${updateRes.newRecordHash.substring(0, 24)}...\`\n` +
                    `- **Transaction ID**: \`${updateRes.txId}\`\n` +
                    `- **Committed By**: \`${callerOrg}\` at ${updateRes.timestamp}\n\n` +
                    `#### 📋 Executed Fabric Transaction Proposal\n${proposalJsonBlock}`
            };
        }

        // 4. GET_PATIENT_HISTORY
        if (intent === 'GET_PATIENT_HISTORY') {
            const historyRes = await this.toolGetPatientHistory(argsMap.patientId, callerOrg);
            if (!historyRes.found) {
                return { response: `❌ ${historyRes.error}` };
            }

            const historyLines = historyRes.history.map((tx, idx) => {
                return `${idx + 1}. **${tx.action || 'Ledger Transaction'}**\n` +
                    `   - **Tx ID**: \`${tx.txId}\`\n` +
                    `   - **Timestamp**: ${tx.timestamp}\n` +
                    `   - **Caller**: \`${tx.caller || 'System'}\`\n` +
                    `   - **Details**: ${tx.details || 'State update committed to ledger'}`;
            }).join('\n\n');

            return {
                executionResult: historyRes,
                response: `### 📜 Chronological Audit Trail: \`${argsMap.patientId}\` (${historyRes.patientName})\n\n` +
                    `Found **${historyRes.totalTransactions} immutable transactions** recorded on **healthcare-channel**:\n\n` +
                    historyLines + `\n\n` +
                    `#### 📋 Executed Fabric Query Proposal\n${proposalJsonBlock}`
            };
        }

        // 5. VERIFY_INTEGRITY
        if (intent === 'VERIFY_INTEGRITY') {
            const recordRes = await this.toolGetPatientRecord(argsMap.patientId, callerOrg);
            if (!recordRes.found) {
                return { response: `❌ ${recordRes.error}` };
            }

            const statusBadge = recordRes.isHashVerified ? '✅ VERIFIED (ZERO TAMPERING)' : '❌ INTEGRITY ALERT: HASH MISMATCH';
            return {
                executionResult: recordRes,
                response: `### 🛡️ Cryptographic Integrity Verification: \`${argsMap.patientId}\`\n\n` +
                    `**Status**: **${statusBadge}**\n\n` +
                    `- **On-Chain Fabric Root Hash**: \`${recordRes.onChain.recordHash}\`\n` +
                    `- **Recomputed LevelDB Hash**: \`${recordRes.offChainHash}\`\n` +
                    `- **Encryption Scheme**: AES-256-GCM with authenticated IV & Tag\n` +
                    `- **Hash Match**: **${recordRes.isHashVerified ? '100% IDENTICAL' : 'MISMATCH'}**\n\n` +
                    `#### 📋 Executed Fabric Query Proposal\n${proposalJsonBlock}`
            };
        }

        // 6. SEARCH_AND_AGGREGATE
        if (intent === 'SEARCH_AND_AGGREGATE') {
            const aggResult = await this.toolSearchAndAggregate(argsMap);
            const conditionTitle = argsMap.condition ? argsMap.condition.toUpperCase() : 'SEARCH RESULTS';
            let targetLabel = argsMap.condition
                ? `diagnosed with **${argsMap.condition.charAt(0).toUpperCase() + argsMap.condition.slice(1)}**`
                : 'matching your criteria';
            if (argsMap.bloodType) targetLabel += ` with blood type **${argsMap.bloodType}**`;
            if (argsMap.gender) targetLabel += ` (**${argsMap.gender}**)`;
            if (argsMap.hospital) targetLabel += ` in **${argsMap.hospital}**`;

            const percentage = aggResult.totalIndexed > 0
                ? ((aggResult.matchedCount / aggResult.totalIndexed) * 100).toFixed(1)
                : '0.0';

            const sampleList = aggResult.matches.slice(0, 6).map(p =>
                `- **${p.patientId}** — **${p.name}** (Age ${p.age}, ${p.gender}) | Condition: **${p.condition}** | Hospital: *${p.hospital}* | Med: *${p.medication}*`
            ).join('\n');

            const distributionSummary = Object.entries(aggResult.conditionCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([cond, cnt]) => `- **${cond}**: **${cnt}** patients (${((cnt / aggResult.totalIndexed) * 100).toFixed(0)}%)`)
                .join('\n');

            return {
                executionResult: aggResult,
                response: `### 🔬 Clinical Analytics: ${conditionTitle}\n\n` +
                    `Found **${aggResult.matchedCount} patients** ${targetLabel} out of **${aggResult.totalIndexed} total records** on the ledger (**${percentage}%**).\n\n` +
                    `#### 🏥 Matched Patient Records:\n` +
                    (sampleList || '_No matching records found._') + `\n\n` +
                    (aggResult.matchedCount > 6 ? `*(Showing first 6 of ${aggResult.matchedCount} matching records)*\n\n` : '') +
                    `#### 📊 Consortium Condition Distribution (${aggResult.totalIndexed} Total Patients):\n` +
                    distributionSummary
            };
        }

        // 7. LIST_PATIENTS
        if (intent === 'LIST_PATIENTS') {
            const listRes = this.toolListPatients();
            const sample = listRes.patients.slice(0, 5).map(p =>
                `- **${p.patientId}** — **${p.name}** (Age ${p.age}, ${p.gender}) | Hospital: *${p.hospital}* | Room: \`${p.roomNumber || 'N/A'}\``
            ).join('\n');

            return {
                executionResult: listRes,
                response: `### 📋 Blockchain Patient Registry Overview\n\n` +
                    `Currently tracking **${listRes.total} patient records** across the consortium:\n\n` +
                    sample + `\n\n` +
                    (listRes.total > 5 ? `*(Showing first 5 of ${listRes.total} records)*\n\n` : '') +
                    `Ask me about any specific patient (e.g. *"Show details for PID-000001"* or *"Grant Hospital B read access to PID-000001"*).`
            };
        }

        // 8. EXPLAIN_ARCHITECTURE
        if (intent === 'EXPLAIN_ARCHITECTURE') {
            return {
                response: `### 🏥 Healthcare Privacy-Preserving Architecture Overview\n\n` +
                    `This system protects patient privacy while guaranteeing mathematical non-repudiation:\n\n` +
                    `1. **Off-Chain Encrypted Storage (LevelDB)**:\n` +
                    `   - Highly sensitive clinical fields (*Medical Condition, Medication, Test Results, Billing Amount*) are encrypted with **AES-256-GCM**.\n` +
                    `   - No plaintext medical data ever touches the blockchain.\n\n` +
                    `2. **On-Chain Fabric Ledger (healthcare-channel)**:\n` +
                    `   - Anchors the root **SHA-256 hash** of the encrypted record.\n` +
                    `   - Stores demographic routing data (*Name, Age, Blood Type, Hospital, Doctor*).\n` +
                    `   - Enforces cryptographic **Role-Based Access Control** (RBAC).\n` +
                    `   - Records an immutable chronological **Audit Trail** of all updates.\n\n` +
                    `3. **Verification Protocol**:\n` +
                    `   - When a peer accesses data, it recomputes \`SHA-256(LevelDB_Record)\` and compares it to the on-chain hash. If identical, authenticity is guaranteed!`
            };
        }

        // 9. DEFAULT: READ_PATIENT_RECORD
        const recordRes = await this.toolGetPatientRecord(argsMap.patientId, callerOrg);
        if (!recordRes.found) {
            return { response: `❌ ${recordRes.error}` };
        }

        const on = recordRes.onChain;
        const off = recordRes.offChainDecrypted || {};
        const integrityBadge = recordRes.isHashVerified ? '✅ Verified SHA-256 Match' : '⚠️ Unverified';

        return {
            executionResult: recordRes,
            response: `### 📋 Comprehensive Record: \`${recordRes.patientId}\` — ${on.name}\n\n` +
                `**Integrity Proof**: **${integrityBadge}** (\`${on.recordHash.substring(0, 16)}...\`)\n\n` +
                `#### 🏥 Hospital & Routing Data (On-Chain)\n` +
                `- **Demographics**: ${on.age} years old | ${on.gender} | Blood Type: **${on.bloodType}**\n` +
                `- **Hospital / Ward**: **${on.hospital}** | Room: **${on.roomNumber || 'Unassigned'}**\n` +
                `- **Admission**: ${on.admissionType || 'Standard'} (Admitted: \`${on.dateOfAdmission || 'N/A'}\` | Discharge: \`${on.dischargeDate || 'Active'}\`)\n` +
                `- **Record Owner / Creator**: \`${on.owner}\` (Created by: *${on.createdBy}* on *${on.createdAt}*)\n\n` +
                `#### 🔬 Clinical Medical Details (Off-Chain Decrypted via AES-256-GCM)\n` +
                `- **Medical Condition**: **${off.medicalCondition || 'N/A'}**\n` +
                `- **Prescribed Medication**: **${off.medication || 'N/A'}**\n` +
                `- **Test Results**: \`${off.testResults || 'Normal'}\`\n` +
                `- **Billing Amount**: **$${Number(off.billingAmount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}**\n` +
                `- **Attending Doctor**: Dr. ${off.doctor || on.updatedBy}\n\n` +
                `#### 🛡️ Active Access Control Policy\n` +
                this.formatAccessControl(on.accessControl) + `\n\n` +
                `#### 📋 Executed Fabric Query Proposal\n${proposalJsonBlock}`
        };
    }

    /**
     * Entry point called by server.js `/api/ai/chat`
     */
    async processQuery(prompt, callerOrg = 'HospitalAMSP') {
        const finalState = await this.workflow.invoke({
            prompt,
            callerOrg
        });

        const engineLabel = finalState.ollamaUsed
            ? `LangGraph + Ollama (${this.model})`
            : 'LangGraph + Deterministic NLP';

        return {
            response: finalState.response,
            engine: engineLabel,
            executedTools: finalState.executedTools || [],
            transactionProposal: finalState.transactionProposal || null
        };
    }

    // =========================================================================
    // Core Tools (Mapping to Fabric Chaincode & LevelDB Operations)
    // =========================================================================

    /**
     * Tool: Retrieve full patient record (On-Chain + Decrypted Off-Chain + Hash Verification)
     */
    async toolGetPatientRecord(patientId, caller = 'HospitalAMSP') {
        const id = this.normalizePatientId(patientId);
        let onChain = this.onChainLedger.get(id);

        // Execute live `peer chaincode query` via FabricBridge if Docker network is running
        const fabricQuery = FabricBridge.query(caller, 'ReadPatientRecord', [id]);
        if (fabricQuery.live) {
            if (fabricQuery.error && fabricQuery.error.includes('not authorized')) {
                return { found: false, error: `Access Denied on Fabric Ledger: Caller ${caller} is not authorized to read ${id}.` };
            }
            if (fabricQuery.data && typeof fabricQuery.data === 'object' && fabricQuery.data.patientId) {
                onChain = fabricQuery.data;
                this.onChainLedger.set(id, onChain);
            }
        }

        if (!onChain) {
            return { found: false, error: `Patient record ${id} was not found on the healthcare-channel ledger.` };
        }

        try {
            const encryptedRecord = await this.store.db.get(id);
            const decryptedRecord = await this.store.getDecryptedPatientRecord(id);
            const computedOffChainHash = this.sha256(encryptedRecord);
            const isHashVerified = (computedOffChainHash === onChain.recordHash);

            return {
                found: true,
                patientId: id,
                isHashVerified,
                liveFabricQuery: fabricQuery.live && !fabricQuery.error,
                onChain: {
                    name: onChain.name,
                    age: onChain.age,
                    gender: onChain.gender,
                    bloodType: onChain.bloodType,
                    hospital: onChain.hospital,
                    owner: onChain.owner,
                    roomNumber: onChain.roomNumber,
                    admissionType: onChain.admissionType,
                    dateOfAdmission: onChain.dateOfAdmission,
                    dischargeDate: onChain.dischargeDate,
                    recordHash: onChain.recordHash,
                    medicalConditionHash: onChain.medicalConditionHash,
                    medicationHash: onChain.medicationHash,
                    testResultsHash: onChain.testResultsHash,
                    billingAmountHash: onChain.billingAmountHash,
                    accessControl: onChain.accessControl,
                    createdAt: onChain.createdAt,
                    createdBy: onChain.createdBy,
                    updatedAt: onChain.updatedAt,
                    updatedBy: onChain.updatedBy
                },
                offChainDecrypted: decryptedRecord,
                offChainHash: computedOffChainHash
            };
        } catch (err) {
            return {
                found: true,
                patientId: id,
                onChain,
                error: `Decryption error: ${err.message}`
            };
        }
    }

    /**
     * Tool: Retrieve chronological audit history from ledger
     */
    async toolGetPatientHistory(patientId, caller = 'HospitalAMSP') {
        const id = this.normalizePatientId(patientId);
        const onChain = this.onChainLedger.get(id);
        if (!onChain) {
            return { found: false, error: `Patient record ${id} not found.` };
        }

        // Execute live `peer chaincode query` for GetPatientHistory if Docker network is running
        const fabricHistory = FabricBridge.query(caller, 'GetPatientHistory', [id]);
        if (fabricHistory.live && Array.isArray(fabricHistory.data) && fabricHistory.data.length > 0) {
            const history = fabricHistory.data.map(item => ({
                txId: item.txId,
                timestamp: item.timestamp,
                caller: (item.value && item.value.updatedBy) || caller,
                action: item.isDelete ? 'DeletePatientRecord' : 'LedgerTransaction',
                details: item.value && item.value.recordHash
                    ? `On-chain state committed (Root Hash: ${String(item.value.recordHash).substring(0, 16)}...)`
                    : 'Ledger state mutation'
            }));
            return {
                found: true,
                patientId: id,
                patientName: onChain.name,
                totalTransactions: history.length,
                history
            };
        }

        const history = this.auditHistory.get(id) || [];
        return {
            found: true,
            patientId: id,
            patientName: onChain.name,
            totalTransactions: history.length,
            history
        };
    }

    /**
     * Tool: Grant access permission to target organization
     */
    async toolGrantAccess(patientId, targetOrg, accessType = 'READ', caller = 'HospitalAMSP') {
        const id = this.normalizePatientId(patientId);
        const record = this.onChainLedger.get(id);
        if (!record) {
            return { success: false, error: `Patient ${id} not found.` };
        }

        const normalizedOrg = this.normalizeOrgName(targetOrg);
        const normalizedAccess = accessType.toUpperCase();

        // Execute live `peer chaincode invoke` via FabricBridge if Docker network is running
        const fabricInvoke = FabricBridge.invoke(caller, 'GrantAccess', [id, normalizedOrg, normalizedAccess]);
        if (fabricInvoke.live && !fabricInvoke.success && fabricInvoke.error && fabricInvoke.error.includes('not authorized')) {
            return { success: false, error: `Fabric Chaincode Rejected: Caller ${caller} is not authorized to grant access for ${id}.` };
        }

        if (!record.accessControl[normalizedOrg]) {
            record.accessControl[normalizedOrg] = [];
        }
        if (!record.accessControl[normalizedOrg].includes(normalizedAccess)) {
            record.accessControl[normalizedOrg].push(normalizedAccess);
        }

        const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);
        record.updatedAt = timestamp;
        record.updatedBy = caller;

        const txId = `tx-ai-grant-${Date.now().toString(16)}`;
        const history = this.auditHistory.get(id) || [];
        history.push({
            txId,
            timestamp,
            caller,
            action: 'GrantAccess',
            details: `LangGraph Agent granted '${normalizedAccess}' access to ${normalizedOrg}`
        });
        this.auditHistory.set(id, history);

        return {
            success: true,
            patientId: id,
            targetOrg: normalizedOrg,
            accessType: normalizedAccess,
            txId,
            updatedAccessControl: record.accessControl,
            timestamp
        };
    }

    /**
     * Tool: Revoke access permission from target organization
     */
    async toolRevokeAccess(patientId, targetOrg, caller = 'HospitalAMSP') {
        const id = this.normalizePatientId(patientId);
        const record = this.onChainLedger.get(id);
        if (!record) {
            return { success: false, error: `Patient ${id} not found.` };
        }

        const normalizedOrg = this.normalizeOrgName(targetOrg);

        // Execute live `peer chaincode invoke` via FabricBridge if Docker network is running
        const fabricInvoke = FabricBridge.invoke(caller, 'RevokeAccess', [id, normalizedOrg]);
        if (fabricInvoke.live && !fabricInvoke.success && fabricInvoke.error && fabricInvoke.error.includes('not authorized')) {
            return { success: false, error: `Fabric Chaincode Rejected: Caller ${caller} is not authorized to revoke access for ${id}.` };
        }

        if (record.accessControl[normalizedOrg]) {
            delete record.accessControl[normalizedOrg];
        }

        const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);
        record.updatedAt = timestamp;
        record.updatedBy = caller;

        const txId = `tx-ai-revoke-${Date.now().toString(16)}`;
        const history = this.auditHistory.get(id) || [];
        history.push({
            txId,
            timestamp,
            caller,
            action: 'RevokeAccess',
            details: `LangGraph Agent revoked access from ${normalizedOrg}`
        });
        this.auditHistory.set(id, history);

        return {
            success: true,
            patientId: id,
            targetOrg: normalizedOrg,
            txId,
            updatedAccessControl: record.accessControl,
            timestamp
        };
    }

    /**
     * Tool: Update clinical, hospital, or financial fields on-chain and in encrypted LevelDB
     */
    async toolUpdatePatientField(patientId, fcn, argsMap, caller = 'HospitalAMSP') {
        const id = this.normalizePatientId(patientId);
        const record = this.onChainLedger.get(id);
        if (!record) {
            return { success: false, error: `Patient ${id} not found.` };
        }

        await this.store.ensureOpen();
        const encryptedRecord = await this.store.db.get(id);
        const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);

        let fieldLabel = '';
        let displayValue = '';
        let chaincodeValueArg = '';

        if (fcn === 'UpdateRoomNumber') {
            record.roomNumber = String(argsMap.roomNumber);
            encryptedRecord.roomNumber = String(argsMap.roomNumber);
            fieldLabel = 'Room Number';
            displayValue = record.roomNumber;
            chaincodeValueArg = record.roomNumber;
        } else if (fcn === 'UpdateMedicalCondition') {
            encryptedRecord.medicalConditionEncrypted = encrypt(argsMap.newCondition);
            record.medicalConditionHash = argsMap.newConditionHash;
            fieldLabel = 'Medical Condition (Encrypted + SHA-256)';
            displayValue = argsMap.newCondition;
            chaincodeValueArg = argsMap.newConditionHash;
        } else if (fcn === 'UpdateMedication') {
            encryptedRecord.medicationEncrypted = encrypt(argsMap.newMedication);
            record.medicationHash = argsMap.newMedicationHash;
            fieldLabel = 'Medication (Encrypted + SHA-256)';
            displayValue = argsMap.newMedication;
            chaincodeValueArg = argsMap.newMedicationHash;
        } else if (fcn === 'UpdateTestResults') {
            encryptedRecord.testResultsEncrypted = encrypt(argsMap.newTestResults);
            record.testResultsHash = argsMap.newTestResultsHash;
            fieldLabel = 'Test Results (Encrypted + SHA-256)';
            displayValue = argsMap.newTestResults;
            chaincodeValueArg = argsMap.newTestResultsHash;
        } else if (fcn === 'UpdateBillingAmount') {
            encryptedRecord.billingAmountEncrypted = encrypt(argsMap.newBillingAmount);
            record.billingAmountHash = argsMap.newBillingHash;
            fieldLabel = 'Billing Amount (Encrypted + SHA-256)';
            displayValue = `$${Number(argsMap.newBillingAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
            chaincodeValueArg = argsMap.newBillingHash;
        } else if (fcn === 'UpdateDischargeDate') {
            record.dischargeDate = argsMap.dischargeDate;
            encryptedRecord.dischargeDate = argsMap.dischargeDate;
            fieldLabel = 'Discharge Date';
            displayValue = argsMap.dischargeDate;
            chaincodeValueArg = argsMap.dischargeDate;
        }

        encryptedRecord.updatedAt = timestamp;
        encryptedRecord.updatedBy = caller;

        // Recompute root SHA-256 hash of encrypted LevelDB record so hash verification stays 100% valid
        const newRecordHash = this.sha256(encryptedRecord);

        // Execute live `peer chaincode invoke` via FabricBridge if Docker network is running
        const fabricInvoke = FabricBridge.invoke(caller, fcn, [id, chaincodeValueArg]);
        if (fabricInvoke.live && !fabricInvoke.success && fabricInvoke.error && fabricInvoke.error.includes('not authorized')) {
            return { success: false, error: `Fabric Chaincode Rejected: Caller ${caller} is not authorized to invoke ${fcn} on ${id}.` };
        }
        if (fabricInvoke.live && fabricInvoke.success) {
            // Also sync the new root recordHash on-chain via UpdatePatientRecord
            FabricBridge.invoke(caller, 'UpdatePatientRecord', [
                id,
                newRecordHash,
                JSON.stringify({
                    roomNumber: record.roomNumber,
                    dischargeDate: record.dischargeDate,
                    medicalConditionHash: record.medicalConditionHash,
                    medicationHash: record.medicationHash,
                    testResultsHash: record.testResultsHash,
                    billingAmountHash: record.billingAmountHash
                })
            ]);
        }

        await this.store.db.put(id, encryptedRecord);

        record.recordHash = newRecordHash;
        record.updatedAt = timestamp;
        record.updatedBy = caller;

        const txId = `tx-ai-update-${Date.now().toString(16)}`;
        const history = this.auditHistory.get(id) || [];
        history.push({
            txId,
            timestamp,
            caller,
            action: fcn,
            details: `Updated ${fieldLabel} to '${displayValue}' (New Root Hash: ${newRecordHash.substring(0, 16)}...)`
        });
        this.auditHistory.set(id, history);

        return {
            success: true,
            patientId: id,
            patientName: record.name,
            fieldLabel,
            displayValue,
            newRecordHash,
            txId,
            timestamp
        };
    }

    /**
     * Tool: List patients on ledger
     */
    toolListPatients(filter = {}) {
        let list = Array.from(this.onChainLedger.values());
        if (filter.hospital) {
            list = list.filter(p => p.hospital.toLowerCase().includes(filter.hospital.toLowerCase()));
        }
        return {
            total: list.length,
            patients: list.map(p => ({
                patientId: p.patientId,
                name: p.name,
                age: p.age,
                gender: p.gender,
                hospital: p.hospital,
                roomNumber: p.roomNumber,
                recordHash: p.recordHash
            }))
        };
    }

    /**
     * Tool: Search, filter, and aggregate clinical and demographic patient data across LevelDB and ledger
     */
    async toolSearchAndAggregate(filters = {}) {
        const matches = [];
        const conditionCounts = {};
        const hospitalCounts = {};
        const genderCounts = {};
        const bloodTypeCounts = {};

        for (const [id, onChain] of this.onChainLedger.entries()) {
            let decrypted = null;
            try {
                decrypted = await this.store.getDecryptedPatientRecord(id);
            } catch (e) {}

            const condition = decrypted && decrypted.medicalCondition ? decrypted.medicalCondition : '';
            const medication = decrypted && decrypted.medication ? decrypted.medication : '';
            const testResults = decrypted && decrypted.testResults ? decrypted.testResults : '';
            const billingAmount = decrypted && decrypted.billingAmount ? decrypted.billingAmount : '';

            if (condition) conditionCounts[condition] = (conditionCounts[condition] || 0) + 1;
            if (onChain.hospital) hospitalCounts[onChain.hospital] = (hospitalCounts[onChain.hospital] || 0) + 1;
            if (onChain.gender) genderCounts[onChain.gender] = (genderCounts[onChain.gender] || 0) + 1;
            if (onChain.bloodType) bloodTypeCounts[onChain.bloodType] = (bloodTypeCounts[onChain.bloodType] || 0) + 1;

            let matchesFilter = true;

            if (filters.condition) {
                const condTarget = filters.condition.toLowerCase().trim();
                if (!condition || !condition.toLowerCase().includes(condTarget)) {
                    matchesFilter = false;
                }
            }

            if (filters.medication) {
                const medTarget = filters.medication.toLowerCase().trim();
                if (!medication || !medication.toLowerCase().includes(medTarget)) {
                    matchesFilter = false;
                }
            }

            if (filters.hospital) {
                const hospTarget = filters.hospital.toLowerCase().trim();
                if (!onChain.hospital || !onChain.hospital.toLowerCase().includes(hospTarget)) {
                    matchesFilter = false;
                }
            }

            if (filters.gender) {
                const genTarget = filters.gender.toLowerCase().trim();
                if (!onChain.gender || onChain.gender.toLowerCase() !== genTarget) {
                    matchesFilter = false;
                }
            }

            if (filters.bloodType) {
                const btTarget = filters.bloodType.toUpperCase().replace(/\s+/g, '');
                const recBt = (onChain.bloodType || '').toUpperCase().replace(/\s+/g, '');
                if (recBt !== btTarget) {
                    matchesFilter = false;
                }
            }

            if (filters.testResults) {
                const trTarget = filters.testResults.toLowerCase().trim();
                if (!testResults || !testResults.toLowerCase().includes(trTarget)) {
                    matchesFilter = false;
                }
            }

            if (matchesFilter) {
                matches.push({
                    patientId: id,
                    name: onChain.name,
                    age: onChain.age,
                    gender: onChain.gender,
                    bloodType: onChain.bloodType,
                    hospital: onChain.hospital,
                    roomNumber: onChain.roomNumber,
                    condition,
                    medication,
                    testResults,
                    billingAmount,
                    recordHash: onChain.recordHash
                });
            }
        }

        return {
            totalIndexed: this.onChainLedger.size,
            matchedCount: matches.length,
            matches,
            conditionCounts,
            hospitalCounts,
            genderCounts,
            bloodTypeCounts
        };
    }

    // =========================================================================
    // Deterministic Entity & Intent Verification Helpers
    // =========================================================================

    extractDeterministicEntities(prompt) {
        const lower = prompt.toLowerCase();

        // 1. Patient ID
        let patientId = this.extractPatientId(prompt);
        if (!patientId) {
            patientId = this.findPatientIdByName(prompt);
        }

        // 2. Target Org & Access Type
        const targetOrg = this.extractOrg(prompt);
        const accessType = this.extractAccessType(prompt);

        // 3. Clinical & Demographic Filters
        const knownConditions = ['cancer', 'asthma', 'diabetes', 'hypertension', 'arthritis', 'obesity'];
        const matchedCondition = knownConditions.find(c => lower.includes(c)) || null;

        const btMatch = lower.match(/\b(a\+|a\-|b\+|b\-|ab\+|ab\-|o\+|o\-)\b/i);
        const bloodTypeFilter = btMatch ? btMatch[1].toUpperCase() : null;

        let genderFilter = null;
        if (/\bmale\b/i.test(prompt) && !/\bfemale\b/i.test(prompt)) genderFilter = 'male';
        else if (/\bfemale\b/i.test(prompt)) genderFilter = 'female';

        let hospitalFilter = null;
        if (lower.includes('hospital a')) hospitalFilter = 'Hospital A';
        else if (lower.includes('hospital b')) hospitalFilter = 'Hospital B';
        else if (lower.includes('hospital c')) hospitalFilter = 'Hospital C';

        // 4. Explicit Intent & Update Value Extraction
        let explicitIntent = null;
        let newValue = null;

        const isUpdateVerb = /\b(update|change|set|modify|assign|move)\b/i.test(lower);

        if (lower.includes('grant') || (lower.includes('give') && lower.includes('access')) || lower.includes('authorize')) {
            explicitIntent = 'GRANT_ACCESS';
        } else if (lower.includes('revoke') || (lower.includes('remove') && lower.includes('access')) || lower.includes('disallow')) {
            explicitIntent = 'REVOKE_ACCESS';
        } else if (isUpdateVerb && lower.includes('room')) {
            explicitIntent = 'UPDATE_ROOM_NUMBER';
            const m = prompt.match(/room(?:\s+number)?(?:\s+of\s+[^\s]+)?\s+(?:to|as|=)\s+([A-Za-z0-9\-]+)/i) ||
                      prompt.match(/(?:to|as)\s+room\s+([A-Za-z0-9\-]+)/i);
            if (m) newValue = m[1];
        } else if (isUpdateVerb && (lower.includes('condition') || lower.includes('diagnosis'))) {
            explicitIntent = 'UPDATE_MEDICAL_CONDITION';
            const m = prompt.match(/(?:condition|diagnosis)(?:\s+of\s+[^\s]+)?\s+(?:to|as|=)\s+([A-Za-z0-9\s\-]+?)(?:$|\.|,|\s+for\s+)/i);
            if (m) newValue = m[1].trim();
            else if (matchedCondition) newValue = matchedCondition.charAt(0).toUpperCase() + matchedCondition.slice(1);
        } else if (isUpdateVerb && lower.includes('medication')) {
            explicitIntent = 'UPDATE_MEDICATION';
            const m = prompt.match(/medication(?:\s+of\s+[^\s]+)?\s+(?:to|as|=)\s+([A-Za-z0-9\s\-]+?)(?:$|\.|,|\s+for\s+)/i);
            if (m) newValue = m[1].trim();
        } else if (isUpdateVerb && lower.includes('test result')) {
            explicitIntent = 'UPDATE_TEST_RESULTS';
            const m = prompt.match(/test\s+results?(?:\s+of\s+[^\s]+)?\s+(?:to|as|=)\s+([A-Za-z0-9\s\-]+?)(?:$|\.|,|\s+for\s+)/i);
            if (m) newValue = m[1].trim();
        } else if (isUpdateVerb && (lower.includes('billing') || lower.includes('bill'))) {
            explicitIntent = 'UPDATE_BILLING_AMOUNT';
            const m = prompt.match(/(?:to|as|=)\s*\$?([0-9,]+(?:\.[0-9]{1,2})?)/i);
            if (m) newValue = m[1].replace(/,/g, '');
        } else if (isUpdateVerb && lower.includes('discharge')) {
            explicitIntent = 'UPDATE_DISCHARGE_DATE';
            const m = prompt.match(/(?:to|as|=)\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
            if (m) newValue = m[1];
        } else if (lower.includes('history') || lower.includes('audit') || lower.includes('provenance') || lower.includes('timeline')) {
            explicitIntent = 'GET_PATIENT_HISTORY';
        } else if (lower.includes('verify') || lower.includes('integrity') || lower.includes('tamper') || lower.includes('hash') || lower.includes('authentic')) {
            explicitIntent = 'VERIFY_INTEGRITY';
        } else if (
            Boolean(matchedCondition || (lower.includes('condition') && (lower.includes('how many') || lower.includes('count') || lower.includes('breakdown')))) ||
            Boolean((genderFilter || bloodTypeFilter || hospitalFilter) && (lower.includes('how many') || lower.includes('count') || lower.includes('number of'))) ||
            Boolean(matchedCondition && (lower.includes('who') || lower.includes('list') || lower.includes('which')))
        ) {
            explicitIntent = 'SEARCH_AND_AGGREGATE';
        } else if (lower.includes('list') || lower.includes('show all') || lower.includes('how many') || lower.includes('statistics') || lower.includes('overview')) {
            explicitIntent = 'LIST_PATIENTS';
        } else if (lower.includes('how') && (lower.includes('work') || lower.includes('architecture') || lower.includes('privacy') || lower.includes('security'))) {
            explicitIntent = 'EXPLAIN_ARCHITECTURE';
        }

        return {
            explicitIntent,
            patientId,
            targetOrg,
            accessType,
            newValue,
            conditionFilter: matchedCondition,
            bloodTypeFilter,
            genderFilter,
            hospitalFilter
        };
    }

    normalizePatientId(raw) {
        if (!raw) return 'PID-000001';
        const str = String(raw).trim();
        const match = str.match(/PID[-_]?(\d+)/i);
        if (match) {
            return `PID-${match[1].padStart(6, '0')}`;
        }
        if (/^\d+$/.test(str)) {
            return `PID-${str.padStart(6, '0')}`;
        }
        return str.toUpperCase();
    }

    extractPatientId(text) {
        const match = text.match(/\bPID[-_]?\d+\b/i);
        if (match) {
            return this.normalizePatientId(match[0]);
        }
        const numMatch = text.match(/patient\s+#?(\d+)/i);
        if (numMatch) {
            return `PID-${numMatch[1].padStart(6, '0')}`;
        }
        return null;
    }

    findPatientIdByName(text) {
        if (!text) return null;
        const lower = text.toLowerCase();
        for (const [key, value] of this.onChainLedger.entries()) {
            if (value.name && lower.includes(value.name.toLowerCase())) {
                return key;
            }
            const firstName = value.name ? value.name.split(' ')[0].toLowerCase() : '';
            if (firstName && firstName.length > 3 && lower.includes(firstName)) {
                return key;
            }
        }
        return null;
    }

    extractOrg(text) {
        const lower = text.toLowerCase();
        if (lower.includes('hospital a') || lower.includes('hospitala')) return 'HospitalAMSP';
        if (lower.includes('hospital b') || lower.includes('hospitalb')) return 'HospitalBMSP';
        if (lower.includes('hospital c') || lower.includes('hospitalc')) return 'HospitalCMSP';
        if (lower.includes('insurance') || lower.includes('billing')) return 'InsuranceOrgMSP';
        return null;
    }

    normalizeOrgName(org) {
        if (!org) return 'HospitalBMSP';
        const clean = org.trim();
        if (clean.endsWith('MSP')) return clean;
        if (/hospital\s*a/i.test(clean)) return 'HospitalAMSP';
        if (/hospital\s*b/i.test(clean)) return 'HospitalBMSP';
        if (/hospital\s*c/i.test(clean)) return 'HospitalCMSP';
        if (/insurance/i.test(clean)) return 'InsuranceOrgMSP';
        return `${clean}MSP`;
    }

    extractAccessType(text) {
        const lower = text.toLowerCase();
        if (lower.includes('admin')) return 'ADMIN';
        if (lower.includes('billing write') || lower.includes('billing_write')) return 'BILLING_WRITE';
        if (lower.includes('billing read') || lower.includes('billing_read') || lower.includes('billing')) return 'BILLING_READ';
        if (lower.includes('write')) return 'WRITE';
        if (lower.includes('read')) return 'READ';
        return null;
    }

    formatAccessControl(acl = {}) {
        const entries = Object.entries(acl);
        if (entries.length === 0) return '_No explicit permissions granted._';
        return entries.map(([org, perms]) => {
            const permList = Array.isArray(perms) ? perms.join(', ') : perms;
            return `- **${org}**: \`[${permList}]\``;
        }).join('\n');
    }
}

module.exports = FabricAiEngine;
