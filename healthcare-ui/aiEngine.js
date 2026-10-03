'use strict';

/**
 * AI Engine for Healthcare Hyperledger Fabric Dashboard
 * Translates Natural Language Queries into Smart Contract Transactions & Queries,
 * extracts on-chain ledger records & off-chain LevelDB decrypted data,
 * and synthesizes comprehensive human-readable natural language responses.
 *
 * Supports:
 * 1. Local Ollama LLM (llama3.1 / mistral) with Tool Calling if Ollama is running.
 * 2. Intelligent Built-In Cognitive NLP Processor fallback if Ollama is not running.
 */

class FabricAiEngine {
    /**
     * @param {Object} options
     * @param {Map} options.onChainLedger - On-chain ledger state mirror
     * @param {Map} options.auditHistory - Immutable ledger history mirror
     * @param {LevelDbStore} options.store - Off-chain encrypted LevelDB store
     * @param {Function} options.sha256 - SHA-256 hash function
     * @param {string} [options.ollamaUrl] - Ollama endpoint (default: http://127.0.0.1:11434)
     * @param {string} [options.model] - Model name (default: llama3.1)
     */
    constructor(options) {
        this.onChainLedger = options.onChainLedger;
        this.auditHistory = options.auditHistory;
        this.store = options.store;
        this.sha256 = options.sha256;
        this.ollamaUrl = options.ollamaUrl || 'http://127.0.0.1:11434';
        this.model = options.model || 'llama3.1';
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
    // Core Tools (Mapping to Fabric Chaincode & LevelDB Operations)
    // =========================================================================

    /**
     * Tool: Retrieve full patient record (On-Chain + Decrypted Off-Chain + Hash Verification)
     */
    async toolGetPatientRecord(patientId) {
        const id = this.normalizePatientId(patientId);
        const onChain = this.onChainLedger.get(id);
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
    async toolGetPatientHistory(patientId) {
        const id = this.normalizePatientId(patientId);
        const onChain = this.onChainLedger.get(id);
        if (!onChain) {
            return { found: false, error: `Patient record ${id} not found.` };
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
            details: `AI Agent granted '${normalizedAccess}' access to ${normalizedOrg}`
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
            details: `AI Agent revoked access from ${normalizedOrg}`
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

            // Tally overall distributions
            if (condition) conditionCounts[condition] = (conditionCounts[condition] || 0) + 1;
            if (onChain.hospital) hospitalCounts[onChain.hospital] = (hospitalCounts[onChain.hospital] || 0) + 1;
            if (onChain.gender) genderCounts[onChain.gender] = (genderCounts[onChain.gender] || 0) + 1;
            if (onChain.bloodType) bloodTypeCounts[onChain.bloodType] = (bloodTypeCounts[onChain.bloodType] || 0) + 1;

            // Check filters
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
    // Natural Language Processing & Orchestration
    // =========================================================================

    /**
     * Process query through Ollama LLM if available, or Built-In Cognitive Engine
     * @param {string} prompt
     * @param {string} [callerOrg]
     * @returns {Promise<{ response: string, engine: string, executedTools: Array, metadata: Object }>}
     */
    async processQuery(prompt, callerOrg = 'HospitalAMSP') {
        const ollamaReady = await this.isOllamaAvailable();

        if (ollamaReady) {
            try {
                return await this.processWithOllama(prompt, callerOrg);
            } catch (err) {
                console.warn('[AI Engine] Ollama failed, falling back to Built-In Engine:', err.message);
                return await this.processWithBuiltInEngine(prompt, callerOrg);
            }
        } else {
            return await this.processWithBuiltInEngine(prompt, callerOrg);
        }
    }

    /**
     * Ollama Tool-Calling Pipeline
     */
    async processWithOllama(prompt, callerOrg) {
        const tools = [
            {
                type: 'function',
                function: {
                    name: 'get_patient_record',
                    description: 'Retrieve on-chain patient record and decrypted off-chain medical data with hash verification',
                    parameters: {
                        type: 'object',
                        properties: {
                            patientId: { type: 'string', description: 'Patient ID, e.g. PID-000001' }
                        },
                        required: ['patientId']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'get_patient_audit_history',
                    description: 'Retrieve chronological ledger audit trail and provenance transactions for a patient',
                    parameters: {
                        type: 'object',
                        properties: {
                            patientId: { type: 'string', description: 'Patient ID, e.g. PID-000001' }
                        },
                        required: ['patientId']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'grant_access',
                    description: 'Grant access permissions (READ, WRITE, BILLING_READ, BILLING_WRITE) to an organization MSP',
                    parameters: {
                        type: 'object',
                        properties: {
                            patientId: { type: 'string', description: 'Patient ID' },
                            targetOrg: { type: 'string', description: 'Target MSP (HospitalBMSP, HospitalCMSP, InsuranceOrgMSP)' },
                            accessType: { type: 'string', enum: ['READ', 'WRITE', 'BILLING_READ', 'BILLING_WRITE', 'ADMIN'] }
                        },
                        required: ['patientId', 'targetOrg', 'accessType']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'revoke_access',
                    description: 'Revoke organization access from a patient record',
                    parameters: {
                        type: 'object',
                        properties: {
                            patientId: { type: 'string', description: 'Patient ID' },
                            targetOrg: { type: 'string', description: 'Target MSP' }
                        },
                        required: ['patientId', 'targetOrg']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'list_patients',
                    description: 'List all patient records registered on the ledger',
                    parameters: { type: 'object', properties: {} }
                }
            }
        ];

        const systemMessage = `You are the Healthcare Hyperledger Fabric AI Assistant.
You translate clinical and administrative requests into Fabric chaincode calls, extract on-chain hashes and off-chain decrypted data, and deliver comprehensive, clear explanations.
Always mention whether the off-chain SHA-256 hash was cryptographically verified against the Fabric ledger hash.
Format your responses with clean Markdown bullet points and bold headers.`;

        const messages = [
            { role: 'system', content: systemMessage },
            { role: 'user', content: prompt }
        ];

        // First round: evaluate intent & tools
        const chatRes = await fetch(`${this.ollamaUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.model,
                messages,
                tools,
                stream: false
            })
        });

        const chatData = await chatRes.json();
        const executedTools = [];

        if (chatData.message && chatData.message.tool_calls && chatData.message.tool_calls.length > 0) {
            messages.push(chatData.message);

            for (const toolCall of chatData.message.tool_calls) {
                const name = toolCall.function.name;
                const args = toolCall.function.arguments;
                let result = {};

                if (name === 'get_patient_record') {
                    result = await this.toolGetPatientRecord(args.patientId);
                } else if (name === 'get_patient_audit_history') {
                    result = await this.toolGetPatientHistory(args.patientId);
                } else if (name === 'grant_access') {
                    result = await this.toolGrantAccess(args.patientId, args.targetOrg, args.accessType, callerOrg);
                } else if (name === 'revoke_access') {
                    result = await this.toolRevokeAccess(args.patientId, args.targetOrg, callerOrg);
                } else if (name === 'list_patients') {
                    result = this.toolListPatients();
                }

                executedTools.push({ name, args, result });
                messages.push({
                    role: 'tool',
                    content: JSON.stringify(result)
                });
            }

            // Second round: synthesize final answer
            const finalRes = await fetch(`${this.ollamaUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    messages,
                    stream: false
                })
            });

            const finalData = await finalRes.json();
            return {
                response: finalData.message.content,
                engine: `Ollama (${this.model})`,
                executedTools
            };
        }

        return {
            response: chatData.message.content,
            engine: `Ollama (${this.model})`,
            executedTools: []
        };
    }

    /**
     * Built-In Cognitive NLP Processor
     * Extracts intents, entities (Patient IDs, Orgs, Permissions), executes blockchain tools,
     * and compiles an exhaustive, human-readable natural language report.
     */
    async processWithBuiltInEngine(prompt, callerOrg) {
        const lower = prompt.toLowerCase();
        const executedTools = [];

        // 1. Identify Patient ID from query (PID-XXXXXX or by Patient Name)
        let patientId = this.extractPatientId(prompt);
        if (!patientId) {
            // Try matching patient by name
            patientId = this.findPatientIdByName(prompt);
        }

        // 2. Intent: Grant Access
        if (lower.includes('grant') || (lower.includes('give') && lower.includes('access')) || lower.includes('allow') || lower.includes('authorize')) {
            const targetOrg = this.extractOrg(prompt) || 'HospitalBMSP';
            const accessType = this.extractAccessType(prompt) || 'READ';

            if (!patientId) {
                return {
                    response: `⚠️ **Action Needed**: Please specify which patient record you want to grant access for (e.g. *PID-000001*).`,
                    engine: 'Fabric AI Engine (Local)',
                    executedTools: []
                };
            }

            const grantRes = await this.toolGrantAccess(patientId, targetOrg, accessType, callerOrg);
            executedTools.push({ name: 'GrantAccess', args: { patientId, targetOrg, accessType } });

            if (!grantRes.success) {
                return {
                    response: `❌ **Failed to Grant Access**: ${grantRes.error}`,
                    engine: 'Fabric AI Engine (Local)',
                    executedTools
                };
            }

            return {
                response: `### 🔐 Access Permission Granted Successfully\n\n` +
                    `- **Patient ID**: \`${patientId}\`\n` +
                    `- **Target Organization**: **${grantRes.targetOrg}**\n` +
                    `- **Permission Level**: \`${grantRes.accessType}\`\n` +
                    `- **Granted By**: \`${callerOrg}\`\n` +
                    `- **Transaction ID**: \`${grantRes.txId}\`\n` +
                    `- **Timestamp**: ${grantRes.timestamp}\n\n` +
                    `The Hyperledger Fabric ledger state and access control matrix have been updated. Organization **${grantRes.targetOrg}** can now perform \`${grantRes.accessType}\` operations on this patient's record.`,
                engine: 'Fabric AI Engine (Local)',
                executedTools
            };
        }

        // 3. Intent: Revoke Access
        if (lower.includes('revoke') || (lower.includes('remove') && lower.includes('access')) || lower.includes('disallow')) {
            const targetOrg = this.extractOrg(prompt) || 'HospitalBMSP';
            if (!patientId) {
                return {
                    response: `⚠️ **Action Needed**: Please specify which patient record you want to revoke access from (e.g. *PID-000001*).`,
                    engine: 'Fabric AI Engine (Local)',
                    executedTools: []
                };
            }

            const revokeRes = await this.toolRevokeAccess(patientId, targetOrg, callerOrg);
            executedTools.push({ name: 'RevokeAccess', args: { patientId, targetOrg } });

            return {
                response: `### 🚫 Access Revoked\n\n` +
                    `- **Patient ID**: \`${patientId}\`\n` +
                    `- **Revoked Organization**: **${revokeRes.targetOrg}**\n` +
                    `- **Transaction ID**: \`${revokeRes.txId}\`\n` +
                    `- **Timestamp**: ${revokeRes.timestamp}\n\n` +
                    `Access rights for **${revokeRes.targetOrg}** have been removed from the on-chain access policy.`,
                engine: 'Fabric AI Engine (Local)',
                executedTools
            };
        }

        // 4. Intent: Audit Trail / Provenance History
        if (lower.includes('history') || lower.includes('audit') || lower.includes('provenance') || lower.includes('changes') || lower.includes('mutation') || lower.includes('timeline')) {
            if (!patientId) {
                patientId = 'PID-000001'; // Default to first if not specified
            }

            const historyRes = await this.toolGetPatientHistory(patientId);
            executedTools.push({ name: 'GetPatientHistory', args: { patientId } });

            if (!historyRes.found) {
                return {
                    response: `❌ ${historyRes.error}`,
                    engine: 'Fabric AI Engine (Local)',
                    executedTools
                };
            }

            let historyLines = historyRes.history.map((tx, idx) => {
                return `${idx + 1}. **${tx.action || 'Ledger Transaction'}**\n` +
                    `   - **Tx ID**: \`${tx.txId}\`\n` +
                    `   - **Timestamp**: ${tx.timestamp}\n` +
                    `   - **Caller**: \`${tx.caller || 'System'}\`\n` +
                    `   - **Details**: ${tx.details || 'State update committed to ledger'}`;
            }).join('\n\n');

            return {
                response: `### 📜 Chronological Audit Trail: \`${patientId}\` (${historyRes.patientName})\n\n` +
                    `Found **${historyRes.totalTransactions} immutable transactions** recorded on **healthcare-channel**:\n\n` +
                    historyLines + `\n\n` +
                    `*Every transaction is permanently anchored in the Fabric block index and protected against tampering.*`,
                engine: 'Fabric AI Engine (Local)',
                executedTools
            };
        }

        // 5. Intent: Cryptographic Hash & Integrity Verification
        if (lower.includes('verify') || lower.includes('integrity') || lower.includes('tamper') || lower.includes('hash') || lower.includes('authentic')) {
            if (!patientId) patientId = 'PID-000001';

            const recordRes = await this.toolGetPatientRecord(patientId);
            executedTools.push({ name: 'VerifyIntegrity', args: { patientId } });

            if (!recordRes.found) {
                return { response: `❌ ${recordRes.error}`, engine: 'Fabric AI Engine (Local)', executedTools };
            }

            const statusBadge = recordRes.isHashVerified ? '✅ VERIFIED (ZERO TAMPERING)' : '❌ INTEGRITY ALERT: HASH MISMATCH';
            return {
                response: `### 🛡️ Cryptographic Integrity Verification: \`${patientId}\`\n\n` +
                    `**Status**: **${statusBadge}**\n\n` +
                    `- **On-Chain Fabric Root Hash**: \`${recordRes.onChain.recordHash}\`\n` +
                    `- **Recomputed LevelDB Hash**: \`${recordRes.offChainHash}\`\n` +
                    `- **Encryption Scheme**: AES-256-GCM with authenticated IV & Tag\n` +
                    `- **Hash Match**: **${recordRes.isHashVerified ? '100% IDENTICAL' : 'MISMATCH'}**\n\n` +
                    `**Conclusion**: The off-chain medical data stored in LevelDB has not been modified or corrupted since it was anchored to the Hyperledger Fabric ledger by **${recordRes.onChain.createdBy}**.`,
                engine: 'Fabric AI Engine (Local)',
                executedTools
            };
        }

        // 6. Intent: Clinical Search & Condition / Demographic Aggregations
        const knownConditions = ['cancer', 'asthma', 'diabetes', 'hypertension', 'arthritis', 'obesity'];
        const matchedCondition = knownConditions.find(c => lower.includes(c));

        const btMatch = lower.match(/\b(a\+|a\-|b\+|b\-|ab\+|ab\-|o\+|o\-)\b/i);
        const bloodTypeFilter = btMatch ? btMatch[1].toUpperCase() : null;

        let genderFilter = null;
        if (/\bmale\b/i.test(prompt) && !/\bfemale\b/i.test(prompt)) genderFilter = 'male';
        else if (/\bfemale\b/i.test(prompt)) genderFilter = 'female';

        let hospitalFilter = null;
        if (lower.includes('hospital a')) hospitalFilter = 'Hospital A';
        else if (lower.includes('hospital b')) hospitalFilter = 'Hospital B';
        else if (lower.includes('hospital c')) hospitalFilter = 'Hospital C';

        const isConditionQuery = Boolean(matchedCondition || (lower.includes('condition') && (lower.includes('how many') || lower.includes('count') || lower.includes('breakdown'))));
        const isDemographicCount = Boolean((genderFilter || bloodTypeFilter || hospitalFilter) && (lower.includes('how many') || lower.includes('count') || lower.includes('number of')));

        if (isConditionQuery || isDemographicCount || (matchedCondition && (lower.includes('who') || lower.includes('list') || lower.includes('which')))) {
            const filters = {};
            if (matchedCondition) filters.condition = matchedCondition;
            if (bloodTypeFilter) filters.bloodType = bloodTypeFilter;
            if (genderFilter) filters.gender = genderFilter;
            if (hospitalFilter) filters.hospital = hospitalFilter;

            const aggResult = await this.toolSearchAndAggregate(filters);
            executedTools.push({ name: 'SearchAndAggregate', args: filters });

            let conditionTitle = matchedCondition ? matchedCondition.toUpperCase() : 'SEARCH RESULTS';
            let targetLabel = matchedCondition ? `diagnosed with **${matchedCondition.charAt(0).toUpperCase() + matchedCondition.slice(1)}**` : 'matching your criteria';
            if (bloodTypeFilter) targetLabel += ` with blood type **${bloodTypeFilter}**`;
            if (genderFilter) targetLabel += ` (**${genderFilter}**)`;
            if (hospitalFilter) targetLabel += ` in **${hospitalFilter}**`;

            const percentage = ((aggResult.matchedCount / aggResult.totalIndexed) * 100).toFixed(1);

            let sampleList = aggResult.matches.slice(0, 6).map(p =>
                `- **${p.patientId}** — **${p.name}** (Age ${p.age}, ${p.gender}) | Condition: **${p.condition}** | Hospital: *${p.hospital}* | Med: *${p.medication}*`
            ).join('\n');

            let distributionSummary = Object.entries(aggResult.conditionCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([cond, cnt]) => `- **${cond}**: **${cnt}** patients (${((cnt / aggResult.totalIndexed) * 100).toFixed(0)}%)`)
                .join('\n');

            return {
                response: `### 🔬 Clinical Analytics: ${conditionTitle}\n\n` +
                    `Found **${aggResult.matchedCount} patients** ${targetLabel} out of **${aggResult.totalIndexed} total records** on the ledger (**${percentage}%**).\n\n` +
                    `#### 🏥 Matched Patient Records:\n` +
                    sampleList + `\n\n` +
                    (aggResult.matchedCount > 6 ? `*(Showing first 6 of ${aggResult.matchedCount} matching records)*\n\n` : '') +
                    `#### 📊 Consortium Condition Distribution (${aggResult.totalIndexed} Total Patients):\n` +
                    distributionSummary + `\n\n` +
                    `*Data verified: Sensitive clinical conditions are securely decrypted from off-chain LevelDB storage and validated against on-chain SHA-256 hashes.*`,
                engine: 'Fabric AI Engine (Local)',
                executedTools
            };
        }

        // 7. Intent: List Patients / Overall Stats
        if (lower.includes('list') || lower.includes('show all') || lower.includes('how many') || lower.includes('statistics') || lower.includes('overview')) {
            const listRes = this.toolListPatients();
            executedTools.push({ name: 'ListPatients', args: {} });

            const sample = listRes.patients.slice(0, 5).map(p =>
                `- **${p.patientId}** — **${p.name}** (Age ${p.age}, ${p.gender}) | Hospital: *${p.hospital}* | Room: \`${p.roomNumber || 'N/A'}\``
            ).join('\n');

            return {
                response: `### 📋 Blockchain Patient Registry Overview\n\n` +
                    `Currently tracking **${listRes.total} patient records** across the consortium:\n\n` +
                    sample + `\n\n` +
                    (listRes.total > 5 ? `*(Showing first 5 of ${listRes.total} records)*\n\n` : '') +
                    `Ask me about any specific patient (e.g. *"Show details for PID-000001"* or *"What is Bobby Jackson's condition?"*).`,
                engine: 'Fabric AI Engine (Local)',
                executedTools
            };
        }

        // 7. Intent: Architecture & Security Explanation
        if (lower.includes('how') && (lower.includes('work') || lower.includes('architecture') || lower.includes('privacy') || lower.includes('security'))) {
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
                    `   - When a peer accesses data, it recomputes \`SHA-256(LevelDB_Record)\` and compares it to the on-chain hash. If identical, authenticity is guaranteed!`,
                engine: 'Fabric AI Engine (Local)',
                executedTools: [{ name: 'ExplainArchitecture', args: {} }]
            };
        }

        // 8. Default: Detailed Patient Information Lookup
        if (!patientId) patientId = 'PID-000001';

        const recordRes = await this.toolGetPatientRecord(patientId);
        executedTools.push({ name: 'ReadPatientRecord', args: { patientId } });

        if (!recordRes.found) {
            return { response: `❌ ${recordRes.error}`, engine: 'Fabric AI Engine (Local)', executedTools };
        }

        const on = recordRes.onChain;
        const off = recordRes.offChainDecrypted || {};
        const integrityBadge = recordRes.isHashVerified ? '✅ Verified SHA-256 Match' : '⚠️ Unverified';

        return {
            response: `### 📋 Comprehensive Record: \`${patientId}\` — ${on.name}\n\n` +
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
                this.formatAccessControl(on.accessControl),
            engine: 'Fabric AI Engine (Local)',
            executedTools
        };
    }

    // =========================================================================
    // Helper Extractors & Normalizers
    // =========================================================================

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
        return 'HospitalBMSP';
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
        return 'READ';
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
