#!/usr/bin/env bash
set -euo pipefail
NEW=${1:?usage: ./set_batch_timeout.sh <1s|500ms|2s>}
FS=${FABRIC_SAMPLES:-$HOME/fabric-samples}
TN=$FS/test-network
export PATH=$FS/bin:$PATH
export FABRIC_CFG_PATH=$FS/config
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID=OrdererMSP
export CORE_PEER_MSPCONFIGPATH=$TN/organizations/ordererOrganizations/example.com/users/Admin@example.com/msp
export CORE_PEER_TLS_ROOTCERT_FILE=$TN/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem
ORDERER_CA=$CORE_PEER_TLS_ROOTCERT_FILE
CH=milkchannel
OPTS="-o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile $ORDERER_CA"
W=$(mktemp -d)

current() {
  peer channel fetch config "$W/$1.pb" $OPTS -c $CH >/dev/null 2>&1
  configtxlator proto_decode --input "$W/$1.pb" --type common.Block \
    | jq '.data.data[0].payload.data.config' > "$W/$1.json"
  jq -r '.channel_group.groups.Orderer.values.BatchTimeout.value.timeout' "$W/$1.json"
}

OLD=$(current before)
echo "Current BatchTimeout: $OLD   ->   requested: $NEW"
if [ "$OLD" = "$NEW" ]; then echo "No change needed."; exit 0; fi

jq --arg t "$NEW" '.channel_group.groups.Orderer.values.BatchTimeout.value.timeout = $t' "$W/before.json" > "$W/modified.json"
configtxlator proto_encode --input "$W/before.json"   --type common.Config --output "$W/original.pb"
configtxlator proto_encode --input "$W/modified.json" --type common.Config --output "$W/modified.pb"
configtxlator compute_update --channel_id $CH --original "$W/original.pb" --updated "$W/modified.pb" --output "$W/update.pb"
configtxlator proto_decode --input "$W/update.pb" --type common.ConfigUpdate > "$W/update.json"
jq -n --arg ch "$CH" --slurpfile u "$W/update.json" \
  '{payload:{header:{channel_header:{channel_id:$ch, type:2}}, data:{config_update:$u[0]}}}' > "$W/envelope.json"
configtxlator proto_encode --input "$W/envelope.json" --type common.Envelope --output "$W/envelope.pb"

peer channel update -f "$W/envelope.pb" -c $CH $OPTS 2>&1 | grep -E "Successfully|Error" || true
sleep 3
NOW=$(current after)
echo "BatchTimeout on the channel: $NOW"
[ "$NOW" = "$NEW" ] && echo "UPDATE SUCCESSFUL" || { echo "ERROR: value not updated"; exit 1; }
rm -rf "$W"
