'use strict';

const { execSync } = require('child_process');
const path = require('path');
const { runIngestion } = require('./ingest');

/**
 * Submits ingested patient records to the running Hyperledger Fabric healthcare network.
 */
async function submitToLedger(limit = 10) {
    console.log(`[Submit] Step 1: Processing ${limit} records from healthcare_dataset.csv into encrypted LevelDB...`);
    const transactions = await runIngestion({ limit });

    console.log(`\n[Submit] Step 2: Submitting on-chain transactions to Fabric ledger...`);
    const networkDir = path.resolve(__dirname, '../healthcare-network');

    for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        const orgMapping = {
            'Hospital A': 'hospitala',
            'Hospital B': 'hospitalb',
            'Hospital C': 'hospitalc'
        };
        const org = orgMapping[tx.hospital] || 'hospitala';

        // Prepare JSON arguments for CreatePatientRecord
        const argsJson = JSON.stringify({
            function: 'CreatePatientRecord',
            Args: [
                tx.patientId,
                tx.recordHash,
                tx.hospital,
                JSON.stringify(tx.metadata)
            ]
        });

        console.log(`[Submit] [${i + 1}/${transactions.length}] Invoking CreatePatientRecord for ${tx.patientId} (as ${org})...`);
        try {
            const cmd = `./network.sh invoke ${org} '${argsJson}'`;
            const output = execSync(cmd, { cwd: networkDir, stdio: 'pipe' }).toString();
            console.log(`[Submit] Success: ${tx.patientId} committed to ledger.`);
        } catch (err) {
            console.error(`[Submit] Failed for ${tx.patientId}: ${err.message}`);
            if (err.stderr) {
                console.error(err.stderr.toString());
            }
        }
    }
}

if (require.main === module) {
    const limit = process.argv[2] ? parseInt(process.argv[2], 10) : 5;
    submitToLedger(limit)
        .then(() => console.log('\n[Submit] Batch submission completed.'))
        .catch((err) => console.error(`[Submit] Error: ${err.message}`));
}

module.exports = { submitToLedger };
