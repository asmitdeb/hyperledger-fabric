'use strict';

const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
const expect = chai.expect;
chai.use(sinonChai);

const HealthcareContract = require('../index');

describe('HealthcareContract Tests', () => {
    let contract;
    let ctx;
    let mockStub;
    let mockClientIdentity;

    beforeEach(() => {
        contract = new HealthcareContract();

        mockStub = {
            getState: sinon.stub(),
            putState: sinon.stub(),
            deleteState: sinon.stub(),
            getHistoryForKey: sinon.stub(),
            setEvent: sinon.stub(),
            getTxTimestamp: sinon.stub().returns({
                seconds: { low: 1727140000, high: 0 }
            })
        };

        mockClientIdentity = {
            getMSPID: sinon.stub().returns('HospitalAMSP'),
            getID: sinon.stub().returns('x509::CN=DoctorA::OU=client')
        };

        ctx = {
            stub: mockStub,
            clientIdentity: mockClientIdentity
        };
    });

    describe('Patient Management', () => {
        it('should return false if patient does not exist', async () => {
            mockStub.getState.resolves(Buffer.from(''));
            const exists = await contract.PatientExists(ctx, 'PID-001');
            expect(exists).to.be.false;
        });

        it('should create a new patient record with provenance and access control', async () => {
            mockStub.getState.resolves(Buffer.from(''));
            mockStub.putState.resolves();

            const metadata = JSON.stringify({
                name: 'Bobby Jackson',
                age: 30,
                gender: 'Male',
                bloodType: 'B-',
                doctorID: 'Matthew Smith',
                hospitalID: 'Hospital A',
                medicalConditionHash: 'hash-condition-1',
                medicationHash: 'hash-med-1',
                testResultsHash: 'hash-test-1',
                billingAmountHash: 'hash-billing-1'
            });

            const resStr = await contract.CreatePatientRecord(ctx, 'PID-001', 'record-hash-sha256', 'Hospital A', metadata);
            const res = JSON.parse(resStr);

            expect(res.patientId).to.equal('PID-001');
            expect(res.recordHash).to.equal('record-hash-sha256');
            expect(res.hospital).to.equal('Hospital A');
            expect(res.createdBy).to.equal('HospitalAMSP');
            expect(res.accessControl['HospitalAMSP']).to.deep.equal(['ADMIN', 'READ', 'WRITE']);

            expect(mockStub.putState).to.have.been.calledOnce;
            expect(mockStub.setEvent).to.have.been.calledWith('PatientCreated');
        });

        it('should reject creating duplicate patient record', async () => {
            mockStub.getState.resolves(Buffer.from('existing-record'));
            try {
                await contract.CreatePatientRecord(ctx, 'PID-001', 'hash', 'Hospital A');
                expect.fail('Should have thrown error');
            } catch (err) {
                expect(err.message).to.include('already exists');
            }
        });

        it('should read patient record if caller is authorized', async () => {
            const stored = {
                patientId: 'PID-001',
                recordHash: 'hash123',
                owner: 'HospitalAMSP',
                hospital: 'Hospital A',
                accessControl: {
                    HospitalAMSP: ['ADMIN']
                }
            };
            mockStub.getState.resolves(Buffer.from(JSON.stringify(stored)));

            const resStr = await contract.ReadPatientRecord(ctx, 'PID-001');
            const res = JSON.parse(resStr);
            expect(res.patientId).to.equal('PID-001');
        });

        it('should deny read access if caller is not authorized', async () => {
            const stored = {
                patientId: 'PID-001',
                recordHash: 'hash123',
                owner: 'HospitalBMSP',
                hospital: 'Hospital B',
                accessControl: {
                    HospitalBMSP: ['ADMIN']
                }
            };
            mockStub.getState.resolves(Buffer.from(JSON.stringify(stored)));

            try {
                await contract.ReadPatientRecord(ctx, 'PID-001');
                expect.fail('Should have denied read');
            } catch (err) {
                expect(err.message).to.include('not authorized to read');
            }
        });

        it('should update patient record if caller has write access', async () => {
            const stored = {
                patientId: 'PID-001',
                recordHash: 'hash-old',
                owner: 'HospitalAMSP',
                hospital: 'Hospital A',
                accessControl: { HospitalAMSP: ['WRITE'] }
            };
            mockStub.getState.resolves(Buffer.from(JSON.stringify(stored)));
            mockStub.putState.resolves();

            const resStr = await contract.UpdatePatientRecord(ctx, 'PID-001', 'hash-new', JSON.stringify({ roomNumber: '404' }));
            const res = JSON.parse(resStr);

            expect(res.recordHash).to.equal('hash-new');
            expect(res.roomNumber).to.equal('404');
            expect(res.updatedBy).to.equal('HospitalAMSP');
            expect(mockStub.putState).to.have.been.calledOnce;
        });

        it('should delete/retire patient record when caller has admin access', async () => {
            const stored = {
                patientId: 'PID-001',
                owner: 'HospitalAMSP',
                accessControl: { HospitalAMSP: ['ADMIN'] }
            };
            mockStub.getState.resolves(Buffer.from(JSON.stringify(stored)));
            mockStub.deleteState.resolves();

            const res = await contract.DeletePatientRecord(ctx, 'PID-001');
            expect(JSON.parse(res).message).to.include('successfully retired');
            expect(mockStub.deleteState).to.have.been.calledWith('PID-001');
        });
    });

    describe('Medical Information Provider', () => {
        let stored;
        beforeEach(() => {
            stored = {
                patientId: 'PID-001',
                owner: 'HospitalAMSP',
                accessControl: { HospitalAMSP: ['WRITE'] }
            };
            mockStub.getState.resolves(Buffer.from(JSON.stringify(stored)));
            mockStub.putState.resolves();
        });

        it('should update medical condition hash', async () => {
            const res = JSON.parse(await contract.UpdateMedicalCondition(ctx, 'PID-001', 'new-condition-hash'));
            expect(res.medicalConditionHash).to.equal('new-condition-hash');
        });

        it('should update medication hash', async () => {
            const res = JSON.parse(await contract.UpdateMedication(ctx, 'PID-001', 'new-medication-hash'));
            expect(res.medicationHash).to.equal('new-medication-hash');
        });

        it('should update test results hash', async () => {
            const res = JSON.parse(await contract.UpdateTestResults(ctx, 'PID-001', 'new-test-hash'));
            expect(res.testResultsHash).to.equal('new-test-hash');
        });
    });

    describe('Hospital Information Services', () => {
        let stored;
        beforeEach(() => {
            stored = {
                patientId: 'PID-001',
                owner: 'HospitalAMSP',
                accessControl: { HospitalAMSP: ['WRITE'] }
            };
            mockStub.getState.resolves(Buffer.from(JSON.stringify(stored)));
            mockStub.putState.resolves();
        });

        it('should update admission details', async () => {
            const res = JSON.parse(await contract.UpdateAdmissionDetails(ctx, 'PID-001', 'Emergency', '2024-02-01'));
            expect(res.admissionType).to.equal('Emergency');
            expect(res.dateOfAdmission).to.equal('2024-02-01');
        });

        it('should update room number', async () => {
            const res = JSON.parse(await contract.UpdateRoomNumber(ctx, 'PID-001', '328'));
            expect(res.roomNumber).to.equal('328');
        });

        it('should update discharge date', async () => {
            const res = JSON.parse(await contract.UpdateDischargeDate(ctx, 'PID-001', '2024-02-10'));
            expect(res.dischargeDate).to.equal('2024-02-10');
        });
    });

    describe('Financial Information Provider', () => {
        it('should allow insurance org to update billing amount if granted access', async () => {
            mockClientIdentity.getMSPID.returns('InsuranceOrgMSP');
            const stored = {
                patientId: 'PID-001',
                owner: 'HospitalAMSP',
                accessControl: { InsuranceOrgMSP: ['BILLING_WRITE'] }
            };
            mockStub.getState.resolves(Buffer.from(JSON.stringify(stored)));
            mockStub.putState.resolves();

            const res = JSON.parse(await contract.UpdateBillingAmount(ctx, 'PID-001', 'billing-hash-999'));
            expect(res.billingAmountHash).to.equal('billing-hash-999');
        });

        it('should update insurance provider', async () => {
            const stored = {
                patientId: 'PID-001',
                owner: 'HospitalAMSP',
                accessControl: { HospitalAMSP: ['WRITE'] }
            };
            mockStub.getState.resolves(Buffer.from(JSON.stringify(stored)));
            mockStub.putState.resolves();

            const res = JSON.parse(await contract.UpdateInsuranceProvider(ctx, 'PID-001', 'Blue Cross'));
            expect(res.insuranceID).to.equal('Blue Cross');
        });
    });

    describe('Security Services (Access Control)', () => {
        let stored;
        beforeEach(() => {
            stored = {
                patientId: 'PID-001',
                owner: 'HospitalAMSP',
                accessControl: { HospitalAMSP: ['ADMIN'] }
            };
            mockStub.getState.resolves(Buffer.from(JSON.stringify(stored)));
            mockStub.putState.resolves();
        });

        it('should grant access to Hospital B and check access', async () => {
            const res = JSON.parse(await contract.GrantAccess(ctx, 'PID-001', 'HospitalBMSP', 'READ'));
            expect(res.accessControl['HospitalBMSP']).to.include('READ');

            // Now check access
            stored.accessControl = res.accessControl;
            mockStub.getState.resolves(Buffer.from(JSON.stringify(stored)));

            const check = JSON.parse(await contract.CheckAccess(ctx, 'PID-001', 'HospitalBMSP', 'READ'));
            expect(check.hasAccess).to.be.true;
        });

        it('should revoke access from Hospital B', async () => {
            stored.accessControl['HospitalBMSP'] = ['READ'];
            const res = JSON.parse(await contract.RevokeAccess(ctx, 'PID-001', 'HospitalBMSP'));
            expect(res.accessControl['HospitalBMSP']).to.be.undefined;
        });
    });

    describe('Audit Services', () => {
        it('should return chronological history for patient', async () => {
            const stored = {
                patientId: 'PID-001',
                owner: 'HospitalAMSP',
                accessControl: { HospitalAMSP: ['READ'] }
            };
            mockStub.getState.resolves(Buffer.from(JSON.stringify(stored)));

            const mockHistoryIterator = {
                next: sinon.stub(),
                close: sinon.stub().resolves()
            };

            mockHistoryIterator.next.onFirstCall().resolves({
                value: {
                    txId: 'tx-1',
                    isDelete: false,
                    timestamp: { seconds: 1727140000 },
                    value: Buffer.from(JSON.stringify({ patientId: 'PID-001', status: 'created' }))
                },
                done: false
            });

            mockHistoryIterator.next.onSecondCall().resolves({
                value: null,
                done: true
            });

            mockStub.getHistoryForKey.resolves(mockHistoryIterator);

            const resStr = await contract.GetPatientHistory(ctx, 'PID-001');
            const history = JSON.parse(resStr);

            expect(history).to.be.an('array').with.lengthOf(1);
            expect(history[0].txId).to.equal('tx-1');
            expect(history[0].value.status).to.equal('created');
        });
    });
});
