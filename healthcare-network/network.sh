#!/usr/bin/env bash
#
# Hyperledger Fabric Network Orchestrator for Healthcare Solution
# Organizations: Hospital A, Hospital B, Hospital C, Insurance Org, Orderer
#

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_PATH="${ROOT_DIR}/../bin"
export PATH="${BIN_PATH}:${PATH}"

CHANNEL_NAME="healthcare-channel"
CC_NAME="healthcare-contract"
CC_VERSION=${CC_VERSION:-"1.0"}
CC_SEQUENCE=${CC_SEQUENCE:-"1"}

function printHelp() {
    echo "Usage: ./network.sh <command>"
    echo "Commands:"
    echo "  generate       - Generate crypto material and genesis block"
    echo "  up             - Bring up Docker containers for 4 peers and 1 orderer"
    echo "  down           - Stop and remove all containers and volumes"
    echo "  createChannel  - Create and join peers to ${CHANNEL_NAME}"
    echo "  deployCC       - Package, install, approve, and commit healthcare chaincode"
}

function generateCrypto() {
    export FABRIC_CFG_PATH="${ROOT_DIR}"
    echo "==> Generating crypto certificates using cryptogen..."
    rm -rf "${ROOT_DIR}/crypto-config" "${ROOT_DIR}/channel-artifacts"
    mkdir -p "${ROOT_DIR}/channel-artifacts"

    cryptogen generate --config="${ROOT_DIR}/crypto-config.yaml" --output="${ROOT_DIR}/crypto-config"

    echo "==> Generating channel genesis block for ${CHANNEL_NAME}..."
    configtxgen -profile HealthcareChannel -outputBlock "${ROOT_DIR}/channel-artifacts/${CHANNEL_NAME}.block" -channelID "${CHANNEL_NAME}"
    echo "==> Crypto materials and genesis block generated successfully."
}

function networkUp() {
    if [ ! -d "${ROOT_DIR}/crypto-config" ]; then
        generateCrypto
    fi
    echo "==> Starting Docker containers..."
    docker-compose -f "${ROOT_DIR}/docker-compose.yaml" up -d
    docker ps --filter "name=peer0" --filter "name=orderer"
}

function networkDown() {
    echo "==> Tearing down healthcare network..."
    docker-compose -f "${ROOT_DIR}/docker-compose.yaml" down -v --remove-orphans || true
    rm -rf "${ROOT_DIR}/crypto-config" "${ROOT_DIR}/channel-artifacts" "${ROOT_DIR}/healthcare-contract.tar.gz"
    echo "==> Network stopped and cleaned up."
}

function createChannel() {
    export FABRIC_CFG_PATH="${ROOT_DIR}/../config"
    echo "==> Creating channel ${CHANNEL_NAME} on Orderer..."
    osnadmin channel join \
        --channelID "${CHANNEL_NAME}" \
        --config-block "${ROOT_DIR}/channel-artifacts/${CHANNEL_NAME}.block" \
        -o localhost:7053 \
        --ca-file "${ORDERER_CA}" \
        --client-cert "${ORDERER_ADMIN_TLS_SIGN_CERT}" \
        --client-key "${ORDERER_ADMIN_TLS_PRIVATE_KEY}"

    echo "==> Joining peers to channel ${CHANNEL_NAME}..."
    for org in hospitala hospitalb hospitalc insurance; do
        echo "--> Joining ${org} peer..."
        setOrg "$org"
        peer channel join -b "${ROOT_DIR}/channel-artifacts/${CHANNEL_NAME}.block"
    done
    echo "==> All peers joined to ${CHANNEL_NAME} successfully."
}

function deployCC() {
    export FABRIC_CFG_PATH="${ROOT_DIR}/../config"
    echo "==> Packaging chaincode..."
    peer lifecycle chaincode package "${ROOT_DIR}/healthcare-contract.tar.gz" \
        --path "${ROOT_DIR}/../healthcare-chaincode" \
        --lang node \
        --label "${CC_NAME}_${CC_VERSION}"

    PACKAGE_ID=$(peer lifecycle chaincode calculatepackageid "${ROOT_DIR}/healthcare-contract.tar.gz")
    echo "==> Package ID: ${PACKAGE_ID}"

    echo "==> Installing chaincode on all 4 peers..."
    for org in hospitala hospitalb hospitalc insurance; do
        echo "--> Installing on ${org}..."
        setOrg "$org"
        peer lifecycle chaincode install "${ROOT_DIR}/healthcare-contract.tar.gz"
    done

    echo "==> Approving chaincode definition for all organizations..."
    for org in hospitala hospitalb hospitalc insurance; do
        echo "--> Approving for ${org}..."
        setOrg "$org"
        peer lifecycle chaincode approveformyorg -o localhost:7050 \
            --ordererTLSHostnameOverride orderer.example.com \
            --tls --cafile "${ORDERER_CA}" \
            --channelID "${CHANNEL_NAME}" \
            --name "${CC_NAME}" \
            --version "${CC_VERSION}" \
            --package-id "${PACKAGE_ID}" \
            --sequence "${CC_SEQUENCE}" \
            --collections-config "${ROOT_DIR}/../healthcare-chaincode/collections_config.json"
    done

    echo "==> Committing chaincode definition to channel..."
    setOrg hospitala
    peer lifecycle chaincode commit -o localhost:7050 \
        --ordererTLSHostnameOverride orderer.example.com \
        --tls --cafile "${ORDERER_CA}" \
        --channelID "${CHANNEL_NAME}" \
        --name "${CC_NAME}" \
        --version "${CC_VERSION}" \
        --sequence "${CC_SEQUENCE}" \
        --collections-config "${ROOT_DIR}/../healthcare-chaincode/collections_config.json" \
        --peerAddresses localhost:7051 --tlsRootCertFiles "${ROOT_DIR}/crypto-config/peerOrganizations/hospitala.example.com/peers/peer0.hospitala.example.com/tls/ca.crt" \
        --peerAddresses localhost:8051 --tlsRootCertFiles "${ROOT_DIR}/crypto-config/peerOrganizations/hospitalb.example.com/peers/peer0.hospitalb.example.com/tls/ca.crt" \
        --peerAddresses localhost:9051 --tlsRootCertFiles "${ROOT_DIR}/crypto-config/peerOrganizations/hospitalc.example.com/peers/peer0.hospitalc.example.com/tls/ca.crt" \
        --peerAddresses localhost:10051 --tlsRootCertFiles "${ROOT_DIR}/crypto-config/peerOrganizations/insurance.example.com/peers/peer0.insurance.example.com/tls/ca.crt"

    echo "==> Chaincode ${CC_NAME} successfully committed to ${CHANNEL_NAME}!"
}

function chaincodeInvoke() {
    export FABRIC_CFG_PATH="${ROOT_DIR}/../config"
    local org=${2:-"hospitala"}
    local cc_args=${3}
    setOrg "$org"
    echo "==> Invoking chaincode as ${org} with args: ${cc_args}"
    peer chaincode invoke -o localhost:7050 \
        --ordererTLSHostnameOverride orderer.example.com \
        --tls --cafile "${ORDERER_CA}" \
        -C "${CHANNEL_NAME}" \
        -n "${CC_NAME}" \
        --peerAddresses localhost:7051 --tlsRootCertFiles "${ROOT_DIR}/crypto-config/peerOrganizations/hospitala.example.com/peers/peer0.hospitala.example.com/tls/ca.crt" \
        --peerAddresses localhost:8051 --tlsRootCertFiles "${ROOT_DIR}/crypto-config/peerOrganizations/hospitalb.example.com/peers/peer0.hospitalb.example.com/tls/ca.crt" \
        --peerAddresses localhost:9051 --tlsRootCertFiles "${ROOT_DIR}/crypto-config/peerOrganizations/hospitalc.example.com/peers/peer0.hospitalc.example.com/tls/ca.crt" \
        --peerAddresses localhost:10051 --tlsRootCertFiles "${ROOT_DIR}/crypto-config/peerOrganizations/insurance.example.com/peers/peer0.insurance.example.com/tls/ca.crt" \
        -c "${cc_args}"
}

function chaincodeQuery() {
    export FABRIC_CFG_PATH="${ROOT_DIR}/../config"
    local org=${2:-"hospitala"}
    local cc_args=${3}
    setOrg "$org"
    echo "==> Querying chaincode as ${org} with args: ${cc_args}"
    peer chaincode query -C "${CHANNEL_NAME}" -n "${CC_NAME}" -c "${cc_args}"
}

MODE=${1:-"help"}

source "${ROOT_DIR}/scripts/envVar.sh"

case "$MODE" in
    generate)
        generateCrypto
        ;;
    up)
        networkUp
        ;;
    down)
        networkDown
        ;;
    createChannel)
        createChannel
        ;;
    deployCC)
        deployCC
        ;;
    invoke)
        chaincodeInvoke "$@"
        ;;
    query)
        chaincodeQuery "$@"
        ;;
    *)
        printHelp
        exit 1
        ;;
esac
