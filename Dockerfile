FROM alpine:3

# Pinned so a PocketBase update can't change behaviour unexpectedly; bump deliberately.
ARG PB_VERSION=0.40.6
ARG TARGETARCH

RUN apk add --no-cache ca-certificates tzdata \
 && wget -qO /tmp/pb.zip "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${TARGETARCH}.zip" \
 && unzip -q /tmp/pb.zip pocketbase -d /pb \
 && rm /tmp/pb.zip

COPY pb_migrations /pb/pb_migrations
COPY pb_hooks /pb/pb_hooks
COPY pb_public /pb/pb_public
COPY --chmod=755 docker/entrypoint.sh /entrypoint.sh
COPY --chmod=755 docker/stamp.sh /stamp.sh
# Set by CI to the commit; makes asset URLs unique per build (see stamp.sh).
ARG APP_VERSION=
RUN /stamp.sh "$APP_VERSION" /pb/pb_public

VOLUME /pb/pb_data
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8090/api/health >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
