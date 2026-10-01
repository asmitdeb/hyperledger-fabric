'use strict';

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const LevelDbStore = require('./levelDbStore');
const { sha256 } = require('./cryptoService');

/**
 * Ingestion script to process healthcare_dataset.csv, encrypt sensitive fields into LevelDB,
 * compute cryptographic hashes, and prepare on-chain transactions for Fabric.
 */
async function runIngestion(options = {}) {
    const csvPath = options.csvPath || path.resolve(__dirname, '../healthcare_dataset.csv');
    const limit = options.limit !== undefined ? options.limit : 50; // default 50 for quick test/run
    const dbPath = options.dbPath || path.resolve(__dirname, './data/leveldb');

    console.log(`[Ingest] Starting ingestion from: ${csvPath}`);
    console.log(`[Ingest] Storing off-chain encrypted records at: ${dbPath}`);
    console.log(`[Ingest] Record limit: ${limit === 0 ? 'ALL' : limit}`);

    const store = new LevelDbStore(dbPath);
    let count = 0;
    const hospitalMapping = ['Hospital A', 'Hospital B', 'Hospital C'];
    const onChainTransactions = [];

    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(csvPath)
            .pipe(csv({
                mapHeaders: ({ header }) => header.trim(),
                mapValues: ({ value }) => (typeof value === 'string' ? value.trim() : value)
            }))
            .on('data', async (row) => {
                count++;
                if (limit > 0 && count > limit) {
                    stream.destroy();
                    return;
                }

                stream.pause();

                const patientId = `PID-${String(count).padStart(6, '0')}`;
                // Assign to one of the 3 hospital orgs
                const assignedHospital = hospitalMapping[(count - 1) % 3];
                const createdAt = '2026-09-01 10:30';
                const updatedAt = '2026-09-04 15:20';
                const createdBy = assignedHospital;
                const updatedBy = row.Doctor || 'Doctor B';

                const recordData = {
                    ...row,
                    createdAt,
                    createdBy,
                    updatedAt,
                    updatedBy
                };

                try {
                    // 1. Off-chain Encrypted LevelDB persistence
                    const offChainResult = await store.putPatientRecord(patientId, recordData);

                    // 2. Prepare on-chain Fabric transaction payload
                    const onChainPayload = {
                        function: 'CreatePatientRecord',
                        patientId,
                        recordHash: offChainResult.recordHash,
                        hospital: assignedHospital,
                        metadata: {
                            name: row.Name,
                            age: Number(row.Age),
                            gender: row.Gender,
                            bloodType: row['Blood Type'],
                            dateOfAdmission: row['Date of Admission'],
                            doctorID: row.Doctor,
                            hospitalID: row.Hospital,
                            insuranceID: row['Insurance Provider'],
                            roomNumber: row['Room Number'],
                            admissionType: row['Admission Type'],
                            dischargeDate: row['Discharge Date'],
                            medicalConditionHash: offChainResult.hashes.medicalConditionHash,
                            medicationHash: offChainResult.hashes.medicationHash,
                            testResultsHash: offChainResult.hashes.testResultsHash,
                            billingAmountHash: offChainResult.hashes.billingAmountHash
                        }
                    };

                    onChainTransactions.push(onChainPayload);

                    if (count <= 5 || count % 200 === 0) {
                        console.log(`[Ingest] Processed ${patientId} -> Hospital: ${assignedHospital} | Hash: ${offChainResult.recordHash.substring(0, 16)}...`);
                    }
                } catch (err) {
                    console.error(`[Ingest] Error processing row ${count}: ${err.message}`);
                }

                stream.resume();
            })
            .on('close', async () => {
                await store.close();
                console.log(`[Ingest] Successfully ingested ${onChainTransactions.length} records into off-chain encrypted LevelDB.`);
                resolve(onChainTransactions);
            })
            .on('end', async () => {
                await store.close();
                console.log(`[Ingest] Completed stream. Total processed: ${onChainTransactions.length}`);
                resolve(onChainTransactions);
            })
            .on('error', async (err) => {
                await store.close();
                reject(err);
            });
    });
}

if (require.main === module) {
    const args = process.argv.slice(2);
    let sampleLimit = 25;
    const limitIndex = args.indexOf('--limit');
    if (limitIndex !== -1 && args[limitIndex + 1]) {
        sampleLimit = parseInt(args[limitIndex + 1], 10);
    }

    runIngestion({ limit: sampleLimit })
        .then((txs) => {
            console.log(`[Ingest] Example on-chain transaction ready for Fabric ledger:`);
            console.log(JSON.stringify(txs[0], null, 2));
            process.exit(0);
        })
        .catch((err) => {
            console.error(`[Ingest] Ingestion failed: ${err.message}`);
            process.exit(1);
        });
}

module.exports = { runIngestion };
