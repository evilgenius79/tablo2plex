#!/bin/sh
exec node app.js \
  --name "$NAME" \
  --id "$DEVICE_ID" \
  --port "$PORT" \
  --channels "$LINEUP_UPDATE_INTERVAL" \
  --xml "$CREATE_XML" \
  --days "$GUIDE_DAYS" \
  --pseudo "$INCLUDE_PSEUDOTV_GUIDE" \
  --level "$LOG_LEVEL" \
  --log "$SAVE_LOG" \
  --outdir /output \
  --user "$USER_NAME" \
  --pass "$USER_PASS" \
  --guide "$GUIDE_UPDATE_INTERVAL" \
  --ott "$INCLUDE_OTT" \
  --ip_address "$IP_ADDRESS" \
  --device "$TABLO_DEVICE"
