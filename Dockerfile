FROM alpine:3

# Pinned so a PocketBase update can't change behaviour unexpectedly; bump deliberately.
ARG PB_VERSION=0.40.6
ARG TARGETARCH

RUN apk add --no-cache ca-certificates tzdata \
 && wget -qO /tmp/pb.zip "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${TARGETARCH}.zip" \
 && unzip -q /tmp/pb.zip pocketbase -d /pb \
 && rm /tmp/pb.zip

COPY pb_migrations /pb/pb_migrations
COPY pb_public /pb/pb_public
COPY --chmod=755 docker/entrypoint.sh /entrypoint.sh

VOLUME /pb/pb_data
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8090/api/health >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
