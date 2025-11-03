docker stop integration-tests-prisma mailpit
docker rm integration-tests-prisma mailpit
docker compose -f test/docker-compose.yml up -d \
    && sleep 3 \
    && bunx prisma migrate deploy \
    && npx jest --runInBand "$1"
docker stop integration-tests-prisma mailpit
docker rm integration-tests-prisma mailpit