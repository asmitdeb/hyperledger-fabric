Architectural design :  Fabric network should consists of three hospital organizations, with each 
organization operating one peer under following conditions
Organization	   Peer(s)	               Role
Hospital A	   1 peer	    Maintains patient records
Hospital B	   1 peer	    Maintains/shared records
Hospital C	   1 peer	    Maintains/shared records
Insurance Org    1 peer	   Insurance/billing access

Should use following fields for writing records in ledger from the given database
PatientID  (not present in data set)
Name
Age
Gender
BloodType
MedicalCondition
DateOfAdmission
DoctorID
HospitalID
InsuranceID
BillingAmount
RoomNumber
AdmissionType
DischargeDate
Medication
TestResults
CreatedAt (not present in data set)
UpdatedAt
CreatedBy
UpdatedBy

The last four fields should be included for provenance mechanism.  
Example: CreatedBy = Hospital A ;  CreatedAt = 2026-09-01 10:30 ;UpdatedBy = Doctor B
    UpdatedAt = 2026-09-04 15:20

Organize the chaincode in following manner
healthcare-chaincode/
│
├── lib/
│   ├── patientRecord.js
│   ├── accessControl.js
│   └── audit.js
│
├── index.js
│
├── package.json
│
└── collections_config.json

Functionality of the chaincodes The main chaincode should expose:

Patient Management services like :
CreatePatientRecord()
ReadPatientRecord()
UpdatePatientRecord()
PatientExists()

Medical Information provider like 
UpdateMedicalCondition()
UpdateMedication()
UpdateTestResults()

Hospital Information services like 
UpdateAdmissionDetails()
UpdateRoomNumber()
UpdateDischargeDate()

Financial Information provider
UpdateBillingAmount()
UpdateInsuranceProvider()

Security services
GrantAccess()
RevokeAccess()
CheckAccess()

Audit services 
GetPatientHistory()


Do not store the actual medical data on-chain

Off-chain storage          Hyperledger Fabric
          │                                     │
   Actual medical data        Patient ID
   Test results                      Record hash
   Medication                      Owner Access policy
   Billing                             Timestamp
                                           Audit trail

Actual database should reside in an encrypted form in  LevelDB
Test Results
Medication
Medical Condition
Billing Amount

Ledger only stores:
PatientID
Hash(record)
Owner
Hospital
Timestamp along with Access permissions and Transaction history


Create a single Healthcare Chaincode containing following grouped transaction functions

CreatePatientRecord()	   for  Add a new patient record
ReadPatientRecord()	for  Retrieve a patient's record
UpdatePatientRecord() for Update an existing record
DeletePatientRecord()	for  Delete/retire a record
PatientExists()	  for   Check whether patient exists
