FROM node:24

WORKDIR /app

COPY package.json package-lock.json /app/

# install required node modules from the committed lockfile so builds are
# reproducible (runtime deps only)
RUN npm ci --omit=dev

# install ffmpeg
RUN apt update && apt install -y --no-install-recommends \
  ffmpeg \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node . /app

RUN chmod +x /app/entrypoint.sh

EXPOSE 8181

# create output directory (for mounted volume) and let the non-root user
# write runtime state (.env is created in /app on first run)
RUN mkdir /output && chown node:node /output /app

# run as the unprivileged node user instead of root
USER node

# set .env variables that can be overridden.
# NOTE: USER_NAME / USER_PASS deliberately have no defaults here — ENV values
# are baked into image metadata (`docker inspect`), so pass them at runtime
# (-e / compose environment) only for the first run, then remove them.
ENV NAME="Tablo 4th Gen Proxy" \
    DEVICE_ID="12345678" \
    PORT="8181" \
    LINEUP_UPDATE_INTERVAL=30 \
    CREATE_XML="false" \
    GUIDE_DAYS=2 \
    INCLUDE_PSEUDOTV_GUIDE="false" \
    LOG_LEVEL="error" \
    SAVE_LOG="true" \
    GUIDE_UPDATE_INTERVAL=24 \
    INCLUDE_OTT="true" \
    IP_ADDRESS="" \
    WARM_TUNER_SECONDS="0" \
    BIND_ADDRESS="" \
    MAX_OTT_STREAMS="8" \
    TABLO_DEVICE=""

ENTRYPOINT ["/app/entrypoint.sh"]
