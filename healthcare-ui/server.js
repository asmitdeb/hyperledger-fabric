'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const LevelDbStore = require('../healthcare-offchain/levelDbStore');
const { encrypt, decrypt, sha256 } = require('../healthcare-offchain/cryptoService');
const { runIngestion } = require('../healthcare-offchain/ingest');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbPath = path.resolve(__dirname, '../healthcare-offchain/data/leveldb');
const store = new LevelDbStore(dbPath);

// In-memory on-chain simulation mirror (synced with Fabric ledger / LevelDB)
const onChainLedger = new Map();
const auditHistory = new Map();

// Helper to check if fabric network docker containers are currently running
function isFabricNetworkRunning() {
    try {
        const out = execSync('docker ps --filter "name=peer0.hospitala" -q', { stdio: 'pipe' }).toString().trim();
        return out.length > 0;
    } catch (e) {
        return false;
    }
}

// Populate sample records if empty
async function initSampleData() {
    if (!fs.existsSync(dbPath)) {
        console.log('[UI Server] LevelDB not found. Running initial 10-record ingestion...');
        await runIngestion({ limit: 10, dbPath });
    }

    // Load records from LevelDB into on-chain mirror
    try {
        for await (const [key, value] of store.db.iterator()) {
            const recordHash = sha256(value);
            const onChainRecord = {
                patientId: key,
                recordHash,
                hospital: value.hospital || 'Hospital A',
                owner: 'HospitalAMSP',
                name: value.name,
                age: value.age,
                gender: value.gender,
                bloodType: value.bloodType,
                roomNumber: value.roomNumber,
                admissionType: value.admissionType,
                dateOfAdmission: value.dateOfAdmission,
                dischargeDate: value.dischargeDate,
                medicalConditionHash: sha256(decrypt(value.medicalConditionEncrypted)),
                medicationHash: sha256(decrypt(value.medicationEncrypted)),
                testResultsHash: sha256(decrypt(value.testResultsEncrypted)),
                billingAmountHash: sha256(decrypt(value.billingAmountEncrypted)),
                accessControl: {
                    HospitalAMSP: ['ADMIN', 'READ', 'WRITE'],
                    HospitalBMSP: ['READ']
                },
                createdAt: value.createdAt || '2026-09-01 10:30',
                createdBy: value.createdBy || 'Hospital A',
                updatedAt: value.updatedAt || '2026-09-04 15:20',
                updatedBy: value.updatedBy || 'Doctor Matthew Smith'
            };
            onChainLedger.set(key, onChainRecord);

            if (!auditHistory.has(key)) {
                auditHistory.set(key, [
                    {
                        txId: `tx-init-${key.toLowerCase()}`,
                        timestamp: onChainRecord.createdAt,
                        caller: onChainRecord.createdBy,
                        action: 'CreatePatientRecord',
                        details: `Created by ${onChainRecord.hospital} with SHA-256 hash ${recordHash.substring(0, 16)}...`
                    }
                ]);
            }
        }
        console.log(`[UI Server] Initialized with ${onChainLedger.size} patient records.`);
    } catch (err) {
        console.error('[UI Server] Error initializing data:', err.message);
    }
}

// API: Overall Network & Ledger Stats
app.get('/api/stats', (req, res) => {
    const isRunning = isFabricNetworkRunning();
    res.json({
        totalPatients: onChainLedger.size,
        fabricNetworkStatus: isRunning ? 'ONLINE' : 'STANDBY',
        channel: 'healthcare-channel',
        organizations: [
            { name: 'Hospital A', mspId: 'HospitalAMSP', role: 'Maintains records', peer: 'peer0.hospitala:7051' },
            { name: 'Hospital B', mspId: 'HospitalBMSP', role: 'Maintains/shared records', peer: 'peer0.hospitalb:8051' },
            { name: 'Hospital C', mspId: 'HospitalCMSP', role: 'Maintains/shared records', peer: 'peer0.hospitalc:9051' },
            { name: 'Insurance Org', mspId: 'InsuranceOrgMSP', role: 'Insurance/billing access', peer: 'peer0.insurance:10051' }
        ],
        encryptionScheme: 'AES-256-GCM',
        hashAlgorithm: 'SHA-256'
    });
});

// API: List Patients
app.get('/api/patients', (req, res) => {
    const list = Array.from(onChainLedger.values()).map(r => ({
        patientId: r.patientId,
        name: r.name,
        age: r.age,
        gender: r.gender,
        hospital: r.hospital,
        recordHash: r.recordHash,
        updatedAt: r.updatedAt
    }));
    res.json(list);
});

// API: Get Single Patient (Detailed On-Chain vs Off-Chain Comparison)
app.get('/api/patients/:id', async (req, res) => {
    const { id } = req.params;
    const onChainRecord = onChainLedger.get(id);

    if (!onChainRecord) {
        return res.status(404).json({ error: `Patient ${id} not found` });
    }

    try {
        // Raw encrypted record from LevelDB
        const encryptedRecord = await store.db.get(id);

        // Decrypted record
        const decryptedRecord = await store.getDecryptedPatientRecord(id);

        // Live hash verification
        const computedOffChainHash = sha256(encryptedRecord);
        const isHashVerified = (computedOffChainHash === onChainRecord.recordHash);

        res.json({
            patientId: id,
            isHashVerified,
            onChain: onChainRecord,
            offChainEncrypted: {
                medicalCondition: encryptedRecord.medicalConditionEncrypted,
                medication: encryptedRecord.medicationEncrypted,
                testResults: encryptedRecord.testResultsEncrypted,
                billingAmount: encryptedRecord.billingAmountEncrypted,
                rawHash: computedOffChainHash
            },
            offChainDecrypted: decryptedRecord
        });
    } catch (err) {
        res.status(500).json({ error: `Failed to load off-chain record: ${err.message}` });
    }
});

// API: Create Patient
app.post('/api/patients', async (req, res) => {
    const {
        name, age, gender, bloodType, medicalCondition,
        dateOfAdmission, doctor, hospital, insuranceProvider,
        billingAmount, roomNumber, admissionType, dischargeDate,
        medication, testResults
    } = req.body;

    const patientId = `PID-${String(onChainLedger.size + 1).padStart(6, '0')}`;
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);
    const assignedHospital = hospital || 'Hospital A';

    const rawData = {
        name, age, gender, bloodType,
        medicalCondition, dateOfAdmission, doctor,
        hospital: assignedHospital,
        insuranceProvider, billingAmount, roomNumber,
        admissionType, dischargeDate, medication, testResults,
        createdAt: timestamp,
        createdBy: assignedHospital,
        updatedAt: timestamp,
        updatedBy: doctor || 'Doctor'
    };

    try {
        // 1. Encrypt and save to LevelDB
        const offChain = await store.putPatientRecord(patientId, rawData);

        // 2. Commit to On-chain record
        const onChainRecord = {
            patientId,
            recordHash: offChain.recordHash,
            hospital: assignedHospital,
            owner: `${assignedHospital.replace(' ', '')}MSP`,
            name, age: Number(age), gender, bloodType,
            roomNumber, admissionType, dateOfAdmission, dischargeDate,
            medicalConditionHash: offChain.hashes.medicalConditionHash,
            medicationHash: offChain.hashes.medicationHash,
            testResultsHash: offChain.hashes.testResultsHash,
            billingAmountHash: offChain.hashes.billingAmountHash,
            accessControl: {
                [`${assignedHospital.replace(' ', '')}MSP`]: ['ADMIN', 'READ', 'WRITE']
            },
            createdAt: timestamp,
            createdBy: assignedHospital,
            updatedAt: timestamp,
            updatedBy: doctor || 'Doctor'
        };

        onChainLedger.set(patientId, onChainRecord);

        // 3. Record Audit Trail
        auditHistory.set(patientId, [
            {
                txId: `tx-create-${Date.now().toString(16)}`,
                timestamp,
                caller: assignedHospital,
                action: 'CreatePatientRecord',
                details: `Registered new record. SHA-256 hash: ${offChain.recordHash.substring(0, 24)}...`
            }
        ]);

        res.json({ success: true, patientId, onChain: onChainRecord });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Grant Access
app.post('/api/patients/:id/grant-access', (req, res) => {
    const { id } = req.params;
    const { targetOrg, accessType } = req.body;

    const record = onChainLedger.get(id);
    if (!record) {
        return res.status(404).json({ error: 'Patient not found' });
    }

    if (!record.accessControl[targetOrg]) {
        record.accessControl[targetOrg] = [];
    }
    if (!record.accessControl[targetOrg].includes(accessType)) {
        record.accessControl[targetOrg].push(accessType);
    }
    record.updatedAt = new Date().toISOString().replace('T', ' ').substring(0, 16);

    // Audit trail
    const history = auditHistory.get(id) || [];
    history.push({
        txId: `tx-grant-${Date.now().toString(16)}`,
        timestamp: record.updatedAt,
        caller: 'HospitalAMSP',
        action: 'GrantAccess',
        details: `Granted ${accessType} permission to ${targetOrg}`
    });
    auditHistory.set(id, history);

    res.json({ success: true, accessControl: record.accessControl });
});

// API: Revoke Access
app.post('/api/patients/:id/revoke-access', (req, res) => {
    const { id } = req.params;
    const { targetOrg } = req.body;

    const record = onChainLedger.get(id);
    if (!record) {
        return res.status(404).json({ error: 'Patient not found' });
    }

    delete record.accessControl[targetOrg];
    record.updatedAt = new Date().toISOString().replace('T', ' ').substring(0, 16);

    const history = auditHistory.get(id) || [];
    history.push({
        txId: `tx-revoke-${Date.now().toString(16)}`,
        timestamp: record.updatedAt,
        caller: 'HospitalAMSP',
        action: 'RevokeAccess',
        details: `Revoked all access permissions from ${targetOrg}`
    });
    auditHistory.set(id, history);

    res.json({ success: true, accessControl: record.accessControl });
});

// API: Audit History
app.get('/api/patients/:id/history', (req, res) => {
    const { id } = req.params;
    const history = auditHistory.get(id) || [];
    res.json(history);
});

// API: Ingest More Rows from CSV
app.post('/api/ingest', async (req, res) => {
    const limit = req.body.limit || 10;
    try {
        const txs = await runIngestion({ limit, dbPath });
        await initSampleData();
        res.json({ success: true, ingestedCount: txs.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start Server
initSampleData().then(() => {
    app.listen(PORT, () => {
        console.log(`\n======================================================`);
        console.log(`🏥 Healthcare Hyperledger Fabric Web Interface Running!`);
        console.log(`👉 Open: http://localhost:${PORT}`);
        console.log(`======================================================\n`);
    });
});
