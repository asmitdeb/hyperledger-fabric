'use strict';

/**
 * Audit provides historical audit trail retrieval for patient records on the Fabric ledger.
 */
class Audit {
    /**
     * Retrieve complete modification history for a patient record key.
     * @param {Context} ctx
     * @param {string} patientId
     * @returns {Promise<Array<Object>>}
     */
    static async getPatientHistory(ctx, patientId) {
        const historyIterator = await ctx.stub.getHistoryForKey(patientId);
        const history = [];

        try {
            while (true) {
                const res = await historyIterator.next();
                if (res.value) {
                    const txRecord = {
                        txId: res.value.txId,
                        isDelete: res.value.isDelete,
                        timestamp: null,
                        value: null
                    };

                    if (res.value.timestamp) {
                        const seconds = res.value.timestamp.seconds.low !== undefined
                            ? res.value.timestamp.seconds.low
                            : res.value.timestamp.seconds;
                        txRecord.timestamp = new Date(seconds * 1000).toISOString();
                    }

                    if (!res.value.isDelete && res.value.value && res.value.value.length > 0) {
                        try {
                            txRecord.value = JSON.parse(res.value.value.toString('utf8'));
                        } catch (err) {
                            txRecord.value = res.value.value.toString('utf8');
                        }
                    }

                    history.push(txRecord);
                }

                if (res.done) {
                    await historyIterator.close();
                    break;
                }
            }
        } catch (error) {
            if (historyIterator && typeof historyIterator.close === 'function') {
                await historyIterator.close();
            }
            throw new Error(`Failed to retrieve history for ${patientId}: ${error.message}`);
        }

        return history;
    }
}

module.exports = Audit;
