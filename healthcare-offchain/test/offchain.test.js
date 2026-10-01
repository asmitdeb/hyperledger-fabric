'use strict';

const path = require('path');
const fs = require('fs');
const { expect } = require('chai');
const { encrypt, decrypt, sha256 } = require('../cryptoService');
const LevelDbStore = require('../levelDbStore');
const { runIngestion } = require('../ingest');

describe('Healthcare Off-Chain Storage & Crypto Tests', () => {
    const testDbPath = path.resolve(__dirname, './test-leveldb');

    afterEach(async () => {
        // cleanup test db
        if (fs.existsSync(testDbPath)) {
            fs.rmSync(testDbPath, { recursive: true, force: true });
        }
    });

    describe('CryptoService', () => {
        it('should encrypt and decrypt sensitive fields correctly with AES-256-GCM', () => {
            const secretData = 'Cancer; Paracetamol; Inconclusive; 18856.28';
            const encrypted = encrypt(secretData);

            expect(encrypted).to.be.a('string');
            expect(encrypted).to.not.include(secretData);
            expect(encrypted.split(':')).to.have.lengthOf(3); // iv:authTag:ciphertext

            const decrypted = decrypt(encrypted);
            expect(decrypted).to.equal(secretData);
        });

        it('should compute valid 64-character SHA-256 hex string', () => {
            const hash = sha256('test-record-content');
            expect(hash).to.have.lengthOf(64);
            expect(hash).to.match(/^[a-f0-9]{64}$/);
        });
    });

    describe('LevelDbStore', () => {
        it('should store encrypted sensitive records and decrypt accurately', async () => {
            const store = new LevelDbStore(testDbPath);

            const sampleRaw = {
                Name: 'Bobby Jackson',
                Age: '30',
                Gender: 'Male',
                'Blood Type': 'B-',
                'Medical Condition': 'Cancer',
                'Date of Admission': '2024-01-31',
                Doctor: 'Matthew Smith',
                Hospital: 'Sons and Miller',
                'Insurance Provider': 'Blue Cross',
                'Billing Amount': '18856.28',
                'Room Number': '328',
                'Admission Type': 'Urgent',
                'Discharge Date': '2024-02-02',
                Medication: 'Paracetamol',
                'Test Results': 'Normal'
            };

            const result = await store.putPatientRecord('PID-000001', sampleRaw);

            expect(result.patientId).to.equal('PID-000001');
            expect(result.recordHash).to.have.lengthOf(64);
            expect(result.hashes.medicalConditionHash).to.have.lengthOf(64);
            expect(result.hashes.medicationHash).to.have.lengthOf(64);
            expect(result.hashes.testResultsHash).to.have.lengthOf(64);
            expect(result.hashes.billingAmountHash).to.have.lengthOf(64);

            // Raw encrypted record check: sensitive text must be encrypted
            expect(result.encryptedRecord.medicalConditionEncrypted).to.not.include('Cancer');
            expect(result.encryptedRecord.medicationEncrypted).to.not.include('Paracetamol');

            // Decrypt check
            const decrypted = await store.getDecryptedPatientRecord('PID-000001');
            expect(decrypted.name).to.equal('Bobby Jackson');
            expect(decrypted.medicalCondition).to.equal('Cancer');
            expect(decrypted.medication).to.equal('Paracetamol');
            expect(decrypted.testResults).to.equal('Normal');
            expect(decrypted.billingAmount).to.equal('18856.28');

            await store.close();
        });
    });

    describe('Ingestion Pipeline', () => {
        it('should ingest sample records from CSV, write to LevelDB, and prepare on-chain transactions', async () => {
            const txs = await runIngestion({
                limit: 5,
                dbPath: testDbPath
            });

            expect(txs).to.be.an('array').with.lengthOf(5);
            expect(txs[0].function).to.equal('CreatePatientRecord');
            expect(txs[0].patientId).to.equal('PID-000001');
            expect(txs[0].recordHash).to.have.lengthOf(64);
            expect(txs[0].hospital).to.equal('Hospital A');
            expect(txs[0].metadata.medicalConditionHash).to.have.lengthOf(64);
            // Verify sensitive values are omitted from on-chain payload
            expect(txs[0].metadata.medicalCondition).to.be.undefined;
            expect(txs[0].metadata.medication).to.be.undefined;
        });
    });
});
