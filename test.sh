docker stop integration-tests-prisma mailpit
docker rm integration-tests-prisma mailpit
docker compose -f test/docker-compose.yml up -d \
    && sleep 1 \
    && bunx prisma migrate deploy \
    && bun test --timeout 100000 "$1"
docker stop integration-tests-prisma mailpit
docker rm integration-tests-prisma mailpit