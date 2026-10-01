'use strict';

const { ClassicLevel } = require('classic-level');
const path = require('path');
const { encrypt, decrypt, sha256 } = require('./cryptoService');

/**
 * LevelDbStore manages encrypted off-chain storage for sensitive medical data.
 */
class LevelDbStore {
    /**
     * @param {string} [dbPath]
     */
    constructor(dbPath) {
        this.dbPath = dbPath || path.resolve(__dirname, './data/leveldb');
        this.db = new ClassicLevel(this.dbPath, { valueEncoding: 'json' });
    }

    /**
     * Store a patient record, encrypting sensitive fields before persisting.
     * Sensitive fields according to specification:
     * - Test Results
     * - Medication
     * - Medical Condition
     * - Billing Amount
     *
     * @param {string} patientId
     * @param {Object} rawData - Full patient record
     * @returns {Promise<{ patientId: string, recordHash: string, encryptedRecord: Object, hashes: Object }>}
     */
    async putPatientRecord(patientId, rawData) {
        // Encrypt the sensitive fields
        const encryptedRecord = {
            patientId,
            name: rawData.name || rawData.Name || '',
            age: rawData.age || rawData.Age,
            gender: rawData.gender || rawData.Gender || '',
            bloodType: rawData.bloodType || rawData['Blood Type'] || '',
            hospital: rawData.hospital || rawData.Hospital || '',
            doctor: rawData.doctor || rawData.Doctor || '',
            insuranceProvider: rawData.insuranceProvider || rawData['Insurance Provider'] || '',
            roomNumber: rawData.roomNumber || rawData['Room Number'] || '',
            admissionType: rawData.admissionType || rawData['Admission Type'] || '',
            dateOfAdmission: rawData.dateOfAdmission || rawData['Date of Admission'] || '',
            dischargeDate: rawData.dischargeDate || rawData['Discharge Date'] || '',

            // Encrypted sensitive fields
            medicalConditionEncrypted: encrypt(rawData.medicalCondition || rawData['Medical Condition']),
            medicationEncrypted: encrypt(rawData.medication || rawData.Medication),
            testResultsEncrypted: encrypt(rawData.testResults || rawData['Test Results']),
            billingAmountEncrypted: encrypt(rawData.billingAmount || rawData['Billing Amount']),

            // Provenance
            createdAt: rawData.createdAt || new Date().toISOString(),
            createdBy: rawData.createdBy || rawData.hospital || 'Hospital A',
            updatedAt: rawData.updatedAt || new Date().toISOString(),
            updatedBy: rawData.updatedBy || rawData.doctor || 'Doctor'
        };

        // Compute sub-hashes
        const hashes = {
            medicalConditionHash: sha256(rawData.medicalCondition || rawData['Medical Condition']),
            medicationHash: sha256(rawData.medication || rawData.Medication),
            testResultsHash: sha256(rawData.testResults || rawData['Test Results']),
            billingAmountHash: sha256(rawData.billingAmount || rawData['Billing Amount'])
        };

        // Root record hash of the full encrypted state
        const recordHash = sha256(encryptedRecord);

        // Store in LevelDB
        await this.db.put(patientId, encryptedRecord);

        return {
            patientId,
            recordHash,
            encryptedRecord,
            hashes
        };
    }

    /**
     * Retrieve and decrypt an off-chain record.
     * @param {string} patientId
     * @returns {Promise<Object>} Decrypted full record
     */
    async getDecryptedPatientRecord(patientId) {
        const encryptedRecord = await this.db.get(patientId);
        if (!encryptedRecord) {
            return null;
        }

        return {
            patientId: encryptedRecord.patientId,
            name: encryptedRecord.name,
            age: encryptedRecord.age,
            gender: encryptedRecord.gender,
            bloodType: encryptedRecord.bloodType,
            hospital: encryptedRecord.hospital,
            doctor: encryptedRecord.doctor,
            insuranceProvider: encryptedRecord.insuranceProvider,
            roomNumber: encryptedRecord.roomNumber,
            admissionType: encryptedRecord.admissionType,
            dateOfAdmission: encryptedRecord.dateOfAdmission,
            dischargeDate: encryptedRecord.dischargeDate,

            // Decrypted sensitive fields
            medicalCondition: decrypt(encryptedRecord.medicalConditionEncrypted),
            medication: decrypt(encryptedRecord.medicationEncrypted),
            testResults: decrypt(encryptedRecord.testResultsEncrypted),
            billingAmount: decrypt(encryptedRecord.billingAmountEncrypted),

            // Provenance
            createdAt: encryptedRecord.createdAt,
            createdBy: encryptedRecord.createdBy,
            updatedAt: encryptedRecord.updatedAt,
            updatedBy: encryptedRecord.updatedBy
        };
    }

    /**
     * Close the LevelDB instance.
     */
    async close() {
        if (this.db) {
            await this.db.close();
        }
    }
}

module.exports = LevelDbStore;
