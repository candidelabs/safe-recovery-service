import {Prisma, PrismaClient} from '@prisma/client'
import logger from "../utils/logger";

const log = logger.child({ component: "prisma" });
// Query logging is opt-in and never on in production. Query params are not logged: they hold user data.
const logQueries = process.env.NODE_ENV !== 'production' && process.env.PRISMA_LOG_QUERIES === 'true';

// PrismaClient only types $on events for a literal `log` tuple; this view types them for ours.
type LogEvents = {
  $on(event: 'warn' | 'error', listener: (event: Prisma.LogEvent) => void): void;
  $on(event: 'query', listener: (event: Prisma.QueryEvent) => void): void;
};

const createPrismaClient = (): PrismaClient => {
  const options: Prisma.PrismaClientOptions = {
    log: [
      {level: 'warn', emit: 'event'},
      {level: 'error', emit: 'event'},
      ...(logQueries ? [{level: 'query' as const, emit: 'event' as const}] : []),
    ],
  };
  const client = new PrismaClient(options) as PrismaClient & LogEvents;
  client.$on('warn', (event) => log.warn({ target: event.target, detail: event.message }, 'prisma warning'));
  client.$on('error', (event) => log.error({ target: event.target, detail: event.message }, 'prisma error'));
  if (logQueries) {
    client.$on('query', (event) => log.debug({ durationMs: event.duration, query: event.query }, 'prisma query'));
  }
  return client;
};

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma = globalForPrisma.prisma || createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
