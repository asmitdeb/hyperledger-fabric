'use strict';

const { Contract } = require('fabric-contract-api');
const PatientRecord = require('./lib/patientRecord');
const AccessControl = require('./lib/accessControl');
const Audit = require('./lib/audit');

/**
 * HealthcareContract implements privacy-preserving patient record management
 * on Hyperledger Fabric, storing cryptographic hashes on-chain while keeping
 * sensitive medical data in off-chain encrypted storage.
 */
class HealthcareContract extends Contract {
    constructor() {
        super('HealthcareContract');
    }

    /**
     * Helper to get transaction timestamp string.
     */
    _getTxTimestamp(ctx) {
        try {
            const txTime = ctx.stub.getTxTimestamp();
            if (txTime && txTime.seconds) {
                const seconds = txTime.seconds.low !== undefined ? txTime.seconds.low : txTime.seconds;
                return new Date(seconds * 1000).toISOString();
            }
        } catch (e) {
            // fallback
        }
        return new Date().toISOString();
    }

    /**
     * Helper to get caller identifier.
     */
    _getCaller(ctx) {
        return AccessControl.getCallerMspId(ctx);
    }

    // =========================================================================
    // 1. Patient Management Services
    // =========================================================================

    /**
     * Check whether a patient record exists on the ledger.
     * @param {Context} ctx
     * @param {string} patientId
     * @returns {boolean}
     */
    async PatientExists(ctx, patientId) {
        const recordBytes = await ctx.stub.getState(patientId);
        return recordBytes && recordBytes.length > 0;
    }

    /**
     * Add a new patient record to the ledger.
     * Sensitive fields must be passed as hashes; full data remains off-chain.
     * @param {Context} ctx
     * @param {string} patientId
     * @param {string} recordHash - SHA-256 hash of entire off-chain encrypted record
     * @param {string} hospital - Hospital identifier (e.g. "Hospital A")
     * @param {string} [metadataJson] - Optional JSON string with non-sensitive demographic & routing info
     */
    async CreatePatientRecord(ctx, patientId, recordHash, hospital, metadataJson) {
        const exists = await this.PatientExists(ctx, patientId);
        if (exists) {
            throw new Error(`Patient record ${patientId} already exists`);
        }

        const caller = this._getCaller(ctx);
        const timestamp = this._getTxTimestamp(ctx);

        let metadata = {};
        if (metadataJson && metadataJson !== '{}') {
            try {
                metadata = typeof metadataJson === 'object' ? metadataJson : JSON.parse(metadataJson);
            } catch (err) {
                throw new Error(`Invalid metadata JSON: ${err.message}`);
            }
        }

        const record = new PatientRecord({
            patientId,
            recordHash,
            owner: caller,
            hospital: hospital || caller,
            name: metadata.name || '',
            age: metadata.age,
            gender: metadata.gender || '',
            bloodType: metadata.bloodType || '',
            dateOfAdmission: metadata.dateOfAdmission || '',
            doctorID: metadata.doctorID || '',
            hospitalID: metadata.hospitalID || hospital || caller,
            insuranceID: metadata.insuranceID || '',
            roomNumber: metadata.roomNumber || '',
            admissionType: metadata.admissionType || '',
            dischargeDate: metadata.dischargeDate || '',
            medicalConditionHash: metadata.medicalConditionHash || '',
            medicationHash: metadata.medicationHash || '',
            testResultsHash: metadata.testResultsHash || '',
            billingAmountHash: metadata.billingAmountHash || '',
            accessControl: metadata.accessControl || {},
            createdAt: timestamp,
            createdBy: caller,
            updatedAt: timestamp,
            updatedBy: caller
        });

        // Grant creating organization ADMIN access by default
        record.accessControl[caller] = ['ADMIN', 'READ', 'WRITE'];

        await ctx.stub.putState(patientId, record.toBuffer());
        ctx.stub.setEvent('PatientCreated', Buffer.from(JSON.stringify({ patientId, hospital, recordHash, timestamp })));

        return JSON.stringify(record);
    }

    /**
     * Retrieve a patient record from the ledger.
     * Enforces access control before returning.
     * @param {Context} ctx
     * @param {string} patientId
     */
    async ReadPatientRecord(ctx, patientId) {
        const recordBytes = await ctx.stub.getState(patientId);
        if (!recordBytes || recordBytes.length === 0) {
            throw new Error(`Patient record ${patientId} does not exist`);
        }

        const record = PatientRecord.fromBuffer(recordBytes);
        const caller = this._getCaller(ctx);

        if (!AccessControl.hasAccess(record, caller, 'READ')) {
            throw new Error(`Caller ${caller} is not authorized to read patient record ${patientId}`);
        }

        return JSON.stringify(record);
    }

    /**
     * Update an existing patient record.
     * @param {Context} ctx
     * @param {string} patientId
     * @param {string} newRecordHash
     * @param {string} [metadataJson]
     */
    async UpdatePatientRecord(ctx, patientId, newRecordHash, metadataJson) {
        const recordBytes = await ctx.stub.getState(patientId);
        if (!recordBytes || recordBytes.length === 0) {
            throw new Error(`Patient record ${patientId} does not exist`);
        }

        const record = PatientRecord.fromBuffer(recordBytes);
        const caller = this._getCaller(ctx);

        if (!AccessControl.hasAccess(record, caller, 'WRITE')) {
            throw new Error(`Caller ${caller} is not authorized to update patient record ${patientId}`);
        }

        const timestamp = this._getTxTimestamp(ctx);

        if (newRecordHash) {
            record.recordHash = newRecordHash;
        }

        if (metadataJson) {
            try {
                const meta = JSON.parse(metadataJson);
                const allowedFields = [
                    'name', 'age', 'gender', 'bloodType', 'dateOfAdmission',
                    'doctorID', 'hospitalID', 'insuranceID', 'roomNumber',
                    'admissionType', 'dischargeDate', 'medicalConditionHash',
                    'medicationHash', 'testResultsHash', 'billingAmountHash'
                ];
                for (const field of allowedFields) {
                    if (meta[field] !== undefined) {
                        record[field] = meta[field];
                    }
                }
            } catch (err) {
                throw new Error(`Invalid metadata JSON: ${err.message}`);
            }
        }

        record.touch(caller, timestamp);
        await ctx.stub.putState(patientId, record.toBuffer());
        ctx.stub.setEvent('PatientUpdated', Buffer.from(JSON.stringify({ patientId, timestamp, updatedBy: caller })));

        return JSON.stringify(record);
    }

    /**
     * Delete/retire a patient record.
     * Requires ADMIN permission.
     * @param {Context} ctx
     * @param {string} patientId
     */
    async DeletePatientRecord(ctx, patientId) {
        const recordBytes = await ctx.stub.getState(patientId);
        if (!recordBytes || recordBytes.length === 0) {
            throw new Error(`Patient record ${patientId} does not exist`);
        }

        const record = PatientRecord.fromBuffer(recordBytes);
        const caller = this._getCaller(ctx);

        if (!AccessControl.hasAccess(record, caller, 'ADMIN')) {
            throw new Error(`Caller ${caller} is not authorized to delete patient record ${patientId}`);
        }

        await ctx.stub.deleteState(patientId);
        ctx.stub.setEvent('PatientDeleted', Buffer.from(JSON.stringify({ patientId, deletedBy: caller })));
        return JSON.stringify({ message: `Patient ${patientId} successfully retired` });
    }

    // =========================================================================
    // 2. Medical Information Provider
    // =========================================================================

    /**
     * Update the medical condition hash.
     * @param {Context} ctx
     * @param {string} patientId
     * @param {string} newConditionHash
     */
    async UpdateMedicalCondition(ctx, patientId, newConditionHash) {
        const recordBytes = await ctx.stub.getState(patientId);
        if (!recordBytes || recordBytes.length === 0) {
            throw new Error(`Patient record ${patientId} does not exist`);
        }
        const record = PatientRecord.fromBuffer(recordBytes);
        const caller = this._getCaller(ctx);

        if (!AccessControl.hasAccess(record, caller, 'WRITE')) {
            throw new Error(`Caller ${caller} is not authorized to update medical condition for ${patientId}`);
        }

        record.medicalConditionHash = newConditionHash;
        record.touch(caller, this._getTxTimestamp(ctx));
        await ctx.stub.putState(patientId, record.toBuffer());
        return JSON.stringify(record);
    }

    /**
     * Update medication hash.
     * @param {Context} ctx
     * @param {string} patientId
     * @param {string} newMedicationHash
     */
    async UpdateMedication(ctx, patientId, newMedicationHash) {
        const recordBytes = await ctx.stub.getState(patientId);
        if (!recordBytes || recordBytes.length === 0) {
            throw new Error(`Patient record ${patientId} does not exist`);
        }
        const record = PatientRecord.fromBuffer(recordBytes);
        const caller = this._getCaller(ctx);

        if (!AccessControl.hasAccess(record, caller, 'WRITE')) {
            throw new Error(`Caller ${caller} is not authorized to update medication for ${patientId}`);
        }

        record.medicationHash = newMedicationHash;
        record.touch(caller, this._getTxTimestamp(ctx));
        await ctx.stub.putState(patientId, record.toBuffer());
        return JSON.stringify(record);
    }

    /**
     * Update test results hash.
     * @param {Context} ctx
     * @param {string} patientId
     * @param {string} newTestResultsHash
     */
    async UpdateTestResults(ctx, patientId, newTestResultsHash) {
        const recordBytes = await ctx.stub.getState(patientId);
        if (!recordBytes || recordBytes.length === 0) {
            throw new Error(`Patient record ${patientId} does not exist`);
        }
        const record = PatientRecord.fromBuffer(recordBytes);
        const caller = this._getCaller(ctx);

        if (!AccessControl.hasAccess(record, caller, 'WRITE')) {
            throw new Error(`Caller ${caller} is not authorized to update test results for ${patientId}`);
        }

        record.testResultsHash = newTestResultsHash;
        record.touch(caller, this._getTxTimestamp(ctx));
        await ctx.stub.putState(patientId, record.toBuffer());
        return JSON.stringify(record);
    }

    // =========================================================================
    // 3. Hospital Information Services
    // =========================================================================

    /**
     * Update admission details.
     * @param {Context} ctx
     * @param {string} patientId
     * @param {string} admissionType
     * @param {string} dateOfAdmission
     */
    async UpdateAdmissionDetails(ctx, patientId, admissionType, dateOfAdmission) {
        const recordBytes = await ctx.stub.getState(patientId);
        if (!recordBytes || recordBytes.length === 0) {
            throw new Error(`Patient record ${patientId} does not exist`);
        }
        const record = PatientRecord.fromBuffer(recordBytes);
        const caller = this._getCaller(ctx);

        if (!AccessControl.hasAccess(record, caller, 'WRITE')) {
            throw new Error(`Caller ${caller} is not authorized to update admission details for ${patientId}`);
        }

        if (admissionType) record.admissionType = admissionType;
        if (dateOfAdmission) record.dateOfAdmission = dateOfAdmission;

        record.touch(caller, this._getTxTimestamp(ctx));
        await ctx.stub.putState(patientId, record.toBuffer());
        return JSON.stringify(record);
    }

    /**
     * Update room number.
     * @param {Context} ctx
     * @param {string} patientId
     * @param {string|number} roomNumber
     */
    async UpdateRoomNumber(ctx, patientId, roomNumber) {
        const recordBytes = await ctx.stub.getState(patientId);
        if (!recordBytes || recordBytes.length === 0) {
            throw new Error(`Patient record ${patientId} does not exist`);
        }
        const record = PatientRecord.fromBuffer(recordBytes);
        const caller = this._getCaller(ctx);

        if (!AccessControl.hasAccess(record, caller, 'WRITE')) {
            throw new Error(`Caller ${caller} is not authorized to update room number for ${patientId}`);
        }

        record.roomNumber = String(roomNumber);
        record.touch(caller, this._getTxTimestamp(ctx));
        await ctx.stub.putState(patientId, record.toBuffer());
        return JSON.stringify(record);
    }

    /**
     * Update discharge date.
     * @param {Context} ctx
     * @param {string} patientId
     * @param {string} dischargeDate
     */
    async UpdateDischargeDate(ctx, patientId, dischargeDate) {
        const recordBytes = await ctx.stub.getState(patientId);
        if (!recordBytes || recordBytes.length === 0) {
            throw new Error(`Patient record ${patientId} does not exist`);
        }
        const record = PatientRecord.fromBuffer(recordBytes);
        const caller = this._getCaller(ctx);

        if (!AccessControl.hasAccess(record, caller, 'WRITE')) {
            throw new Error(`Caller ${caller} is not authorized to update discharge date for ${patientId}`);
        }

        record.dischargeDate = dischargeDate;
        record.touch(caller, this._getTxTimestamp(ctx));
        await ctx.stub.putState(patientId, record.toBuffer());
        return JSON.stringify(record);
    }

    // =========================================================================
    // 4. Financial Information Provider
    // =========================================================================

    /**
     * Update billing amount hash.
     * @param {Context} ctx
     * @param {string} patientId
     * @param {string} newBillingHash
     */
    async UpdateBillingAmount(ctx, patientId, newBillingHash) {
        const recordBytes = await ctx.stub.getState(patientId);
        if (!recordBytes || recordBytes.length === 0) {
            throw new Error(`Patient record ${patientId} does not exist`);
        }
        const record = PatientRecord.fromBuffer(recordBytes);
        const caller = this._getCaller(ctx);

        const isAuthorized = AccessControl.hasAccess(record, caller, 'WRITE') ||
                             AccessControl.hasAccess(record, caller, 'BILLING_WRITE');
        if (!isAuthorized) {
            throw new Error(`Caller ${caller} is not authorized to update billing amount for ${patientId}`);
        }

        record.billingAmountHash = newBillingHash;
        record.touch(caller, this._getTxTimestamp(ctx));
        await ctx.stub.putState(patientId, record.toBuffer());
        return JSON.stringify(record);
    }

    /**
     * Update insurance provider ID.
     * @param {Context} ctx
     * @param {string} patientId
     * @param {string} insuranceId
     */
    async UpdateInsuranceProvider(ctx, patientId, insuranceId) {
        const recordBytes = await ctx.stub.getState(patientId);
        if (!recordBytes || recordBytes.length === 0) {
            throw new Error(`Patient record ${patientId} does not exist`);
        }
        const record = PatientRecord.fromBuffer(recordBytes);
        const caller = this._getCaller(ctx);

        const isAuthorized = AccessControl.hasAccess(record, caller, 'WRITE') ||
                             AccessControl.hasAccess(record, caller, 'BILLING_WRITE');
        if (!isAuthorized) {
            throw new Error(`Caller ${caller} is not authorized to update insurance provider for ${patientId}`);
        }

        record.insuranceID = insuranceId;
        record.touch(caller, this._getTxTimestamp(ctx));
        await ctx.stub.putState(patientId, record.toBuffer());
        return JSON.stringify(record);
    }

    // =========================================================================
    // 5. Security Services
    // =========================================================================

    /**
     * Grant access to an organization or identity for a patient record.
     * @param {Context} ctx
     * @param {string} patientId
     * @param {string} targetOrgOrUser
     * @param {string} accessType - 'READ', 'WRITE', 'ADMIN', 'BILLING_READ', 'BILLING_WRITE'
     */
    async GrantAccess(ctx, patientId, targetOrgOrUser, accessType) {
        const recordBytes = await ctx.stub.getState(patientId);
        if (!recordBytes || recordBytes.length === 0) {
            throw new Error(`Patient record ${patientId} does not exist`);
        }
        const record = PatientRecord.fromBuffer(recordBytes);
        const caller = this._getCaller(ctx);

        AccessControl.grant(record, caller, targetOrgOrUser, accessType);
        record.touch(caller, this._getTxTimestamp(ctx));

        await ctx.stub.putState(patientId, record.toBuffer());
        ctx.stub.setEvent('AccessGranted', Buffer.from(JSON.stringify({ patientId, target: targetOrgOrUser, accessType })));

        return JSON.stringify(record);
    }

    /**
     * Revoke access from an organization or identity.
     * @param {Context} ctx
     * @param {string} patientId
     * @param {string} targetOrgOrUser
     */
    async RevokeAccess(ctx, patientId, targetOrgOrUser) {
        const recordBytes = await ctx.stub.getState(patientId);
        if (!recordBytes || recordBytes.length === 0) {
            throw new Error(`Patient record ${patientId} does not exist`);
        }
        const record = PatientRecord.fromBuffer(recordBytes);
        const caller = this._getCaller(ctx);

        AccessControl.revoke(record, caller, targetOrgOrUser);
        record.touch(caller, this._getTxTimestamp(ctx));

        await ctx.stub.putState(patientId, record.toBuffer());
        ctx.stub.setEvent('AccessRevoked', Buffer.from(JSON.stringify({ patientId, target: targetOrgOrUser })));

        return JSON.stringify(record);
    }

    /**
     * Check if an organization or user has the specified access right.
     * @param {Context} ctx
     * @param {string} patientId
     * @param {string} targetOrgOrUser
     * @param {string} accessType
     * @returns {boolean}
     */
    async CheckAccess(ctx, patientId, targetOrgOrUser, accessType) {
        const recordBytes = await ctx.stub.getState(patientId);
        if (!recordBytes || recordBytes.length === 0) {
            throw new Error(`Patient record ${patientId} does not exist`);
        }
        const record = PatientRecord.fromBuffer(recordBytes);
        const hasAccess = AccessControl.hasAccess(record, targetOrgOrUser, accessType);
        return JSON.stringify({ patientId, targetOrgOrUser, accessType, hasAccess });
    }

    // =========================================================================
    // 6. Audit Services
    // =========================================================================

    /**
     * Retrieve full chronological transaction provenance and audit trail for a patient.
     * @param {Context} ctx
     * @param {string} patientId
     * @returns {string} JSON array of historical versions
     */
    async GetPatientHistory(ctx, patientId) {
        const exists = await this.PatientExists(ctx, patientId);
        if (!exists) {
            throw new Error(`Patient record ${patientId} does not exist`);
        }

        // Verify caller access
        const recordBytes = await ctx.stub.getState(patientId);
        const record = PatientRecord.fromBuffer(recordBytes);
        const caller = this._getCaller(ctx);

        if (!AccessControl.hasAccess(record, caller, 'READ')) {
            throw new Error(`Caller ${caller} is not authorized to view audit history for ${patientId}`);
        }

        const history = await Audit.getPatientHistory(ctx, patientId);
        return JSON.stringify(history);
    }
}

module.exports = HealthcareContract;
module.exports.contracts = [HealthcareContract];
