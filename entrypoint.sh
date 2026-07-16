#!/bin/sh
# USER_NAME / USER_PASS are intentionally NOT passed as --user/--pass flags:
# argv is visible to `ps` and `docker inspect` while the container runs.
# The app reads them from the environment directly instead.
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
  --guide "$GUIDE_UPDATE_INTERVAL" \
  --ott "$INCLUDE_OTT" \
  --ip_address "$IP_ADDRESS" \
  --warm "$WARM_TUNER_SECONDS" \
  --bind "$BIND_ADDRESS" \
  --maxott "$MAX_OTT_STREAMS" \
  --device "$TABLO_DEVICE"
