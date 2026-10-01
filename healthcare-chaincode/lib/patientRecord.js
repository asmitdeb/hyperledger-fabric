'use strict';

/**
 * PatientRecord represents the privacy-preserving on-chain ledger representation
 * of a patient record.
 * Sensitive medical details (Test Results, Medication, Medical Condition, Billing Amount)
 * are stored strictly as cryptographic hashes, referencing off-chain encrypted storage.
 */
class PatientRecord {
    /**
     * @param {Object} data
     */
    constructor(data = {}) {
        this.patientId = data.patientId;
        this.recordHash = data.recordHash; // SHA-256 hash of entire off-chain record
        this.owner = data.owner;           // Creating entity / Org MSP
        this.hospital = data.hospital;     // Hospital organization (Hospital A, B, or C)

        // Non-sensitive routing and demographic fields
        this.name = data.name || '';
        this.age = data.age !== undefined ? Number(data.age) : null;
        this.gender = data.gender || '';
        this.bloodType = data.bloodType || '';
        this.dateOfAdmission = data.dateOfAdmission || '';
        this.doctorID = data.doctorID || '';
        this.hospitalID = data.hospitalID || data.hospital || '';
        this.insuranceID = data.insuranceID || '';
        this.roomNumber = data.roomNumber || '';
        this.admissionType = data.admissionType || '';
        this.dischargeDate = data.dischargeDate || '';

        // Hashes of sensitive medical data components
        this.medicalConditionHash = data.medicalConditionHash || '';
        this.medicationHash = data.medicationHash || '';
        this.testResultsHash = data.testResultsHash || '';
        this.billingAmountHash = data.billingAmountHash || '';

        // Security / Access Control List: { [orgOrUserId]: ['READ', 'WRITE', ...] }
        this.accessControl = data.accessControl || {};

        // Provenance Mechanism
        this.createdAt = data.createdAt || new Date().toISOString();
        this.createdBy = data.createdBy || '';
        this.updatedAt = data.updatedAt || this.createdAt;
        this.updatedBy = data.updatedBy || this.createdBy;
    }

    /**
     * Serialize to Buffer for Fabric ledger storage.
     * @returns {Buffer}
     */
    toBuffer() {
        return Buffer.from(JSON.stringify(this));
    }

    /**
     * Deserialize from ledger state Buffer/string.
     * @param {Buffer|string} buffer
     * @returns {PatientRecord}
     */
    static fromBuffer(buffer) {
        if (!buffer || buffer.length === 0) {
            return null;
        }
        const json = JSON.parse(buffer.toString('utf8'));
        return new PatientRecord(json);
    }

    /**
     * Update provenance tracking.
     * @param {string} updatedBy
     * @param {string} timestamp
     */
    touch(updatedBy, timestamp) {
        this.updatedBy = updatedBy;
        this.updatedAt = timestamp || new Date().toISOString();
    }
}

module.exports = PatientRecord;
