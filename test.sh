docker compose -f test/docker-compose.yml up -d \
    && sleep 1 \
    && bunx prisma migrate deploy \
    && bun test "$1"\
    && docker compose -f test/docker-compose.yml down || docker compose -f test/docker-compose.yml down
