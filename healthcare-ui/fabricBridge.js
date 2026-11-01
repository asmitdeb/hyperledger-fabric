'use strict';

const { execFileSync, execSync } = require('child_process');
const path = require('path');

const NETWORK_DIR = path.resolve(__dirname, '../healthcare-network');
const NETWORK_SH = path.join(NETWORK_DIR, 'network.sh');

const MSP_TO_ORG_CLI = {
    HospitalAMSP: 'hospitala',
    HospitalBMSP: 'hospitalb',
    HospitalCMSP: 'hospitalc',
    InsuranceOrgMSP: 'insurance',
    'Hospital A': 'hospitala',
    'Hospital B': 'hospitalb',
    'Hospital C': 'hospitalc',
    'Insurance Org': 'insurance'
};

class FabricBridge {
    /**
     * Check if Hyperledger Fabric peer container is running in Docker.
     * @returns {boolean}
     */
    static isNetworkRunning() {
        try {
            const out = execSync('docker ps --filter "name=peer0.hospitala" --filter "status=running" -q', {
                stdio: 'pipe',
                timeout: 2500
            }).toString().trim();
            return out.length > 0;
        } catch (e) {
            return false;
        }
    }

    /**
     * Map MSP ID or Organization Name to network.sh CLI org identifier.
     * @param {string} mspOrOrg
     * @returns {string}
     */
    static resolveCliOrg(mspOrOrg = 'HospitalAMSP') {
        if (!mspOrOrg) return 'hospitala';
        if (MSP_TO_ORG_CLI[mspOrOrg]) return MSP_TO_ORG_CLI[mspOrOrg];
        const lower = String(mspOrOrg).toLowerCase();
        if (lower.includes('hospitalb') || lower.includes('hospital b')) return 'hospitalb';
        if (lower.includes('hospitalc') || lower.includes('hospital c')) return 'hospitalc';
        if (lower.includes('insurance')) return 'insurance';
        return 'hospitala';
    }

    /**
     * Execute a real `peer chaincode query` via `./network.sh query <org> <json>`
     * @param {string} callerOrg - MSP ID or org name
     * @param {string} fcn - Chaincode function name
     * @param {Array<string>} args - String arguments array
     * @returns {{ live: boolean, data: any, rawOutput?: string, error?: string }}
     */
    static query(callerOrg, fcn, args = []) {
        if (!this.isNetworkRunning()) {
            return { live: false, data: null };
        }

        const cliOrg = this.resolveCliOrg(callerOrg);
        const payload = JSON.stringify({
            function: fcn,
            Args: args.map(a => String(a ?? ''))
        });

        try {
            console.log(`🔗 [Fabric Peer Query] ./network.sh query ${cliOrg} '${payload}'`);
            const raw = execFileSync(NETWORK_SH, ['query', cliOrg, payload], {
                cwd: NETWORK_DIR,
                stdio: 'pipe',
                timeout: 15000
            }).toString('utf8');

            // Strip the "==> Querying chaincode..." banner line from network.sh
            const lines = raw
                .split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0 && !l.startsWith('==>'));

            const jsonLine = lines[lines.length - 1] || '{}';
            let parsed = jsonLine;
            try {
                parsed = JSON.parse(jsonLine);
            } catch (_) {
                // Keep raw string if not JSON
            }

            return {
                live: true,
                cliOrg,
                data: parsed,
                rawOutput: jsonLine
            };
        } catch (err) {
            const stderr = err.stderr ? err.stderr.toString('utf8').trim() : err.message;
            console.warn(`⚠️ [Fabric Peer Query Warning] (${fcn}): ${stderr}`);
            return {
                live: true,
                cliOrg,
                data: null,
                error: stderr
            };
        }
    }

    /**
     * Execute a real `peer chaincode invoke` via `./network.sh invoke <org> <json>`
     * @param {string} callerOrg - MSP ID or org name
     * @param {string} fcn - Chaincode function name
     * @param {Array<string>} args - String arguments array
     * @returns {{ live: boolean, success: boolean, rawOutput?: string, error?: string }}
     */
    static invoke(callerOrg, fcn, args = []) {
        if (!this.isNetworkRunning()) {
            return { live: false, success: false };
        }

        const cliOrg = this.resolveCliOrg(callerOrg);
        const payload = JSON.stringify({
            function: fcn,
            Args: args.map(a => String(a ?? ''))
        });

        try {
            console.log(`⛓️  [Fabric Peer Invoke] ./network.sh invoke ${cliOrg} '${payload}'`);
            const raw = execFileSync(NETWORK_SH, ['invoke', cliOrg, payload], {
                cwd: NETWORK_DIR,
                stdio: 'pipe',
                timeout: 20000
            }).toString('utf8');

            return {
                live: true,
                cliOrg,
                success: true,
                rawOutput: raw.trim()
            };
        } catch (err) {
            const stderr = err.stderr ? err.stderr.toString('utf8').trim() : err.message;
            console.warn(`⚠️ [Fabric Peer Invoke Warning] (${fcn}): ${stderr}`);
            return {
                live: true,
                cliOrg,
                success: false,
                error: stderr
            };
        }
    }
}

module.exports = FabricBridge;

