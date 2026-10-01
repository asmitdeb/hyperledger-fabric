'use strict';

/**
 * AccessControl provides role-based and attribute-based security services for patient records.
 */
class AccessControl {
    /**
     * Get caller's MSP ID from the transaction context.
     * @param {Context} ctx
     * @returns {string}
     */
    static getCallerMspId(ctx) {
        if (ctx.clientIdentity && typeof ctx.clientIdentity.getMSPID === 'function') {
            return ctx.clientIdentity.getMSPID();
        }
        return 'UnknownMSP';
    }

    /**
     * Get caller's unique client ID / certificate ID.
     * @param {Context} ctx
     * @returns {string}
     */
    static getCallerId(ctx) {
        if (ctx.clientIdentity && typeof ctx.clientIdentity.getID === 'function') {
            return ctx.clientIdentity.getID();
        }
        return 'UnknownCaller';
    }

    /**
     * Check if the caller has the required access type on a patient record.
     * @param {Object} patientRecord - Stored patient record
     * @param {string} caller - Caller MSP ID or user identifier
     * @param {string} requiredAccess - 'READ', 'WRITE', 'ADMIN', 'BILLING_READ', 'BILLING_WRITE'
     * @returns {boolean}
     */
    static hasAccess(patientRecord, caller, requiredAccess) {
        if (!patientRecord) {
            return false;
        }

        // The record owner/creator always has full access
        if (patientRecord.owner === caller || patientRecord.hospital === caller || patientRecord.createdBy === caller) {
            return true;
        }

        const accessList = patientRecord.accessControl || {};
        const permissions = accessList[caller];

        if (!permissions) {
            return false;
        }

        if (Array.isArray(permissions)) {
            // ADMIN has all permissions
            if (permissions.includes('ADMIN')) {
                return true;
            }
            return permissions.includes(requiredAccess);
        }

        return false;
    }

    /**
     * Grant access to a target organization or identity.
     * @param {Object} patientRecord
     * @param {string} caller - Who is requesting the grant
     * @param {string} target - Target MSP ID or user ID
     * @param {string} accessType - Permission to grant
     */
    static grant(patientRecord, caller, target, accessType) {
        if (!AccessControl.hasAccess(patientRecord, caller, 'ADMIN')) {
            throw new Error(`Caller ${caller} is not authorized to grant access for patient ${patientRecord.patientId}`);
        }

        if (!patientRecord.accessControl) {
            patientRecord.accessControl = {};
        }

        const existing = patientRecord.accessControl[target] || [];
        if (!existing.includes(accessType)) {
            existing.push(accessType);
        }
        patientRecord.accessControl[target] = existing;
    }

    /**
     * Revoke access from a target organization or identity.
     * @param {Object} patientRecord
     * @param {string} caller
     * @param {string} target
     */
    static revoke(patientRecord, caller, target) {
        if (!AccessControl.hasAccess(patientRecord, caller, 'ADMIN')) {
            throw new Error(`Caller ${caller} is not authorized to revoke access for patient ${patientRecord.patientId}`);
        }

        if (patientRecord.accessControl && patientRecord.accessControl[target]) {
            delete patientRecord.accessControl[target];
        }
    }
}

module.exports = AccessControl;
