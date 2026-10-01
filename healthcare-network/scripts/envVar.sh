#!/usr/bin/env bash

# Environment variable helper for Hospital A, B, C, and Insurance Org

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export ORDERER_CA="${ROOT_DIR}/crypto-config/ordererOrganizations/example.com/orderers/orderer.example.com/tls/ca.crt"
export ORDERER_ADMIN_TLS_SIGN_CERT="${ROOT_DIR}/crypto-config/ordererOrganizations/example.com/orderers/orderer.example.com/tls/server.crt"
export ORDERER_ADMIN_TLS_PRIVATE_KEY="${ROOT_DIR}/crypto-config/ordererOrganizations/example.com/orderers/orderer.example.com/tls/server.key"
export CORE_PEER_TLS_ENABLED=true

setOrg() {
    local org=$1
    if [ "$org" = "hospitala" ] || [ "$org" = "1" ]; then
        export CORE_PEER_LOCALMSPID="HospitalAMSP"
        export CORE_PEER_TLS_ROOTCERT_FILE="${ROOT_DIR}/crypto-config/peerOrganizations/hospitala.example.com/peers/peer0.hospitala.example.com/tls/ca.crt"
        export CORE_PEER_MSPCONFIGPATH="${ROOT_DIR}/crypto-config/peerOrganizations/hospitala.example.com/users/Admin@hospitala.example.com/msp"
        export CORE_PEER_ADDRESS=localhost:7051
    elif [ "$org" = "hospitalb" ] || [ "$org" = "2" ]; then
        export CORE_PEER_LOCALMSPID="HospitalBMSP"
        export CORE_PEER_TLS_ROOTCERT_FILE="${ROOT_DIR}/crypto-config/peerOrganizations/hospitalb.example.com/peers/peer0.hospitalb.example.com/tls/ca.crt"
        export CORE_PEER_MSPCONFIGPATH="${ROOT_DIR}/crypto-config/peerOrganizations/hospitalb.example.com/users/Admin@hospitalb.example.com/msp"
        export CORE_PEER_ADDRESS=localhost:8051
    elif [ "$org" = "hospitalc" ] || [ "$org" = "3" ]; then
        export CORE_PEER_LOCALMSPID="HospitalCMSP"
        export CORE_PEER_TLS_ROOTCERT_FILE="${ROOT_DIR}/crypto-config/peerOrganizations/hospitalc.example.com/peers/peer0.hospitalc.example.com/tls/ca.crt"
        export CORE_PEER_MSPCONFIGPATH="${ROOT_DIR}/crypto-config/peerOrganizations/hospitalc.example.com/users/Admin@hospitalc.example.com/msp"
        export CORE_PEER_ADDRESS=localhost:9051
    elif [ "$org" = "insurance" ] || [ "$org" = "4" ]; then
        export CORE_PEER_LOCALMSPID="InsuranceOrgMSP"
        export CORE_PEER_TLS_ROOTCERT_FILE="${ROOT_DIR}/crypto-config/peerOrganizations/insurance.example.com/peers/peer0.insurance.example.com/tls/ca.crt"
        export CORE_PEER_MSPCONFIGPATH="${ROOT_DIR}/crypto-config/peerOrganizations/insurance.example.com/users/Admin@insurance.example.com/msp"
        export CORE_PEER_ADDRESS=localhost:10051
    else
        echo "Unknown organization: $org"
        exit 1
    fi
}
