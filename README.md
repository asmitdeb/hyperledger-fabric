# Healthcare Privacy-Preserving Hyperledger Fabric Solution

This project implements the enterprise healthcare blockchain architecture specified in [HEALTHCARE.md](file:///Users/asmitdeb/go/src/github.com/asmitdeb/fabric-samples/HEALTHCARE.md) using data from [healthcare_dataset.csv](file:///Users/asmitdeb/go/src/github.com/asmitdeb/fabric-samples/healthcare_dataset.csv).

---

## 1. Architecture Overview

### Organizations & Network Topology
- **Hospital A** (`HospitalAMSP`): Maintains primary patient records.
- **Hospital B** (`HospitalBMSP`): Maintains and shares patient records.
- **Hospital C** (`HospitalCMSP`): Maintains and shares patient records.
- **Insurance Org** (`InsuranceOrgMSP`): Read/Write access to billing and insurance metadata.
- **Orderer Org** (`OrdererMSP`): Raft consensus cluster for deterministic transaction sequencing.

### Privacy-Preserving Off-Chain vs On-Chain Model

```
+----------------------------------------------------------------------------------------------------+
|                                    Healthcare Dataset (CSV)                                        |
+-------------------------------------------------+--------------------------------------------------+
                                                  | Ingestion & Encryption (AES-256-GCM)
                                                  v
+-------------------------------------------------+--------------------------------------------------+
|                     Off-Chain Storage Layer (Encrypted LevelDB)                                    |
| - Sensitive Medical Fields (Encrypted):                                                            |
|   * Test Results, Medication, Medical Condition, Billing Amount                                    |
| - Key: PatientID ("PID-000001") -> Encrypted Payload (IV, AuthTag, Ciphertext)                     |
+-------------------------------------------------+--------------------------------------------------+
                                                  | Computes SHA-256 Record Hash
                                                  v
+----------------------------------------------------------------------------------------------------+
|                               Hyperledger Fabric Network & Ledger                                  |
| Channel: healthcare-channel                                                                        |
|                                                                                                    |
| Ledger State (On-Chain) per Patient:                                                               |
|   - PatientID: "PID-XXXXX"                                                                        |
|   - RecordHash: SHA-256 hash of entire off-chain encrypted record                                 |
|   - Owner: Creating organization / patient identity                                                |
|   - Hospital: Hospital A / B / C                                                                   |
|   - AccessControl: { "HospitalBMSP": ["READ"], "InsuranceOrgMSP": ["BILLING_WRITE"] }             |
|   - Provenance Tracking: CreatedAt, CreatedBy, UpdatedAt, UpdatedBy                                |
|   - Audit History: Full chronological ledger mutations via GetPatientHistory()                     |
+----------------------------------------------------------------------------------------------------+
```

---

## 2. Directory Structure

```
fabric-samples/
│
├── healthcare-chaincode/               # Hyperledger Fabric Smart Contract (Node.js)
│   ├── lib/
│   │   ├── patientRecord.js            # Patient state model & serialization
│   │   ├── accessControl.js            # Fine-grained access control logic (RBAC / ABAC)
│   │   └── audit.js                    # Historical provenance & audit querying
│   ├── index.js                        # Main contract exposing all transaction functions
│   ├── package.json                    # Dependencies & Mocha/Chai test runner
│   ├── collections_config.json         # Fabric Private Data Collections configuration
│   └── test/
│       └── healthcareContract.test.js  # 18 unit tests with mock stubs
│
├── healthcare-offchain/                # Off-chain LevelDB & Ingestion Service
│   ├── cryptoService.js                # AES-256-GCM encryption & SHA-256 hashing
│   ├── levelDbStore.js                 # LevelDB repository for encrypted medical data
│   ├── ingest.js                       # CSV streaming ingestion & payload generator
│   ├── package.json                    # Dependencies & test runner
│   └── test/
│       └── offchain.test.js            # Crypto & LevelDB test suite
│
└── healthcare-network/                 # 4-Org Network Configuration
    ├── crypto-config.yaml              # Cryptogen specs for Hospital A, B, C, Insurance, Orderer
    ├── configtx.yaml                   # Channel profiles, MSP definitions, and Raft config
    ├── docker-compose.yaml             # 4 peers and 1 orderer container setup
    ├── network.sh                      # Automation script (generate, up, createChannel, deployCC, down)
    └── scripts/
        └── envVar.sh                   # Environment variable switcher for organizations
```

---

## 3. Implemented Chaincode Functions

### Patient Management
- `CreatePatientRecord(ctx, patientId, recordHash, hospital, metadataJson)`
- `ReadPatientRecord(ctx, patientId)` (Enforces access control)
- `UpdatePatientRecord(ctx, patientId, newRecordHash, metadataJson)`
- `DeletePatientRecord(ctx, patientId)` (Requires ADMIN permission)
- `PatientExists(ctx, patientId)`

### Medical Information Provider
- `UpdateMedicalCondition(ctx, patientId, newConditionHash)`
- `UpdateMedication(ctx, patientId, newMedicationHash)`
- `UpdateTestResults(ctx, patientId, newTestResultsHash)`

### Hospital Information Services
- `UpdateAdmissionDetails(ctx, patientId, admissionType, dateOfAdmission)`
- `UpdateRoomNumber(ctx, patientId, roomNumber)`
- `UpdateDischargeDate(ctx, patientId, dischargeDate)`

### Financial Information Provider
- `UpdateBillingAmount(ctx, patientId, newBillingHash)` (Authorized for billing roles)
- `UpdateInsuranceProvider(ctx, patientId, insuranceId)`

### Security Services (Access Control)
- `GrantAccess(ctx, patientId, targetOrgOrUser, accessType)`
- `RevokeAccess(ctx, patientId, targetOrgOrUser)`
- `CheckAccess(ctx, patientId, targetOrgOrUser, accessType)`

### Audit Services
- `GetPatientHistory(ctx, patientId)` (Returns chronological block transactions from key history)

---

## 4. Verification & Testing

### Running Chaincode Unit Tests
```bash
cd healthcare-chaincode
npm test
```
*Results: 18 unit tests passing across all transaction groups, access control checks, provenance, and audit trails.*

### Running Off-Chain Crypto & LevelDB Tests
```bash
cd ../healthcare-offchain
npm test
```
*Results: 4 tests passing, verifying AES-256-GCM encryption/decryption roundtrips, LevelDB storage without plaintext leakage, and dataset ingestion.*

### Ingesting Healthcare Dataset
To ingest sample records from `healthcare_dataset.csv` into off-chain LevelDB and generate on-chain payloads:
```bash
cd ../healthcare-offchain
node ingest.js --limit 50
```

### Network Orchestration (When Docker Desktop is Running)
```bash
cd ../healthcare-network

# 1. Generate crypto materials & genesis block
./network.sh generate

# 2. Launch 4 peer nodes and Raft orderer
./network.sh up

# 3. Create healthcare-channel and join peers
./network.sh createChannel

# 4. Package, approve, and deploy the smart contract
./network.sh deployCC

# 5. Query a patient record
./network.sh query hospitala '{"function":"ReadPatientRecord","Args":["PID-000001"]}'

# 6. Tear down when done
./network.sh down
```

### Automated Ingest & Submit to Ledger
To ingest from the CSV, encrypt into LevelDB, and automatically invoke transactions onto the Fabric network in one command:
```bash
cd ../healthcare-offchain
node submitToLedger.js 10
```

---

### Sample CLI Chaincode Invocations & Queries

Once the network is running and records are submitted, you can interact with the ledger from `healthcare-network/` using `./network.sh invoke` and `./network.sh query`.

#### 1. Querying Patient Records & Access Rights
```bash
cd ../healthcare-network

# Read patient record as Hospital A (verifies caller has READ access)
./network.sh query hospitala '{"function":"ReadPatientRecord","Args":["PID-000001"]}'

# Check if Insurance Org has READ access to the patient record
./network.sh query hospitala '{"function":"CheckAccess","Args":["PID-000001","InsuranceOrgMSP","READ"]}'
```

#### 2. Access Control (Grant & Revoke Permissions)
```bash
# Grant READ access to the Insurance Organization (owner or ADMIN permission required)
./network.sh invoke hospitala '{"function":"GrantAccess","Args":["PID-000001","InsuranceOrgMSP","READ"]}'

# Query the record as Insurance Org (now succeeds with authorized access)
./network.sh query insurance '{"function":"ReadPatientRecord","Args":["PID-000001"]}'

# Revoke READ access from the Insurance Organization
./network.sh invoke hospitala '{"function":"RevokeAccess","Args":["PID-000001","InsuranceOrgMSP"]}'
```

#### 3. Updating Clinical & Financial Hashes
```bash
# Update patient's Medical Condition SHA-256 hash (simulating an updated diagnosis)
./network.sh invoke hospitala '{"function":"UpdateMedicalCondition","Args":["PID-000001","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"]}'

# Update Medication SHA-256 hash
./network.sh invoke hospitala '{"function":"UpdateMedication","Args":["PID-000001","4e5b3b162b0f4d48c5eb75cf681efb0cabe155e811c541c98bf721d99012dca5"]}'

# Update Billing Amount hash (authorized for WRITE or BILLING_WRITE roles)
./network.sh invoke hospitala '{"function":"UpdateBillingAmount","Args":["PID-000001","a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e"]}'

# Update Bed/Room Number
./network.sh invoke hospitala '{"function":"UpdateRoomNumber","Args":["PID-000001","412-B"]}'
```

#### 4. Audit Trail & Provenance History
```bash
# Query the full chronological audit history (every modification, timestamp, and updater)
./network.sh query hospitala '{"function":"GetPatientHistory","Args":["PID-000001"]}'
```

#### 5. Local Decryption of Off-Chain Records (Client-Side)
```bash
# Retrieve and decrypt the sensitive medical record locally using AES-256-GCM
cd ../healthcare-offchain
node -e "const LevelDbStore = require('./levelDbStore'); (async () => { const db = new LevelDbStore(); const rec = await db.getDecryptedPatientRecord('PID-000001'); console.log(JSON.stringify(rec, null, 2)); await db.close(); })();"
```

