import { SiweMessage } from 'siwe';
import { verifySiweMessageData } from '../src/utils/utilities';

const account = '0x1111111111111111111111111111111111111111';
const chainId = 1;
const statement = 'register';

function buildMessage(args: {
  issuedAt: string;
  expirationTime?: string;
}): SiweMessage {
  return new SiweMessage({
    domain: 'localhost',
    address: account,
    statement,
    uri: 'https://localhost',
    version: '1',
    chainId,
    nonce: Math.random().toString(36).slice(2),
    issuedAt: args.issuedAt,
    expirationTime: args.expirationTime,
  });
}

describe('verifySiweMessageData issuedAt freshness', () => {
  it('rejects stale issuedAt even when expirationTime is far in the future', () => {
    const issuedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const expirationTime = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const [ok, err] = verifySiweMessageData(
      buildMessage({ issuedAt, expirationTime }),
      account,
      chainId,
      statement,
    );
    expect(ok).toBe(false);
    expect(err).toMatch(/issuedAt is valid only for 5 minutes/);
  });

  it('rejects expirationTime lifetime longer than 5 minutes', () => {
    const issuedAt = new Date().toISOString();
    const expirationTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const [ok, err] = verifySiweMessageData(
      buildMessage({ issuedAt, expirationTime }),
      account,
      chainId,
      statement,
    );
    expect(ok).toBe(false);
    expect(err).toMatch(/expirationTime exceeds the 5 minute maximum lifetime/);
  });

  it('accepts fresh issuedAt with short expirationTime', () => {
    const issuedAt = new Date().toISOString();
    const expirationTime = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    const [ok, err] = verifySiweMessageData(
      buildMessage({ issuedAt, expirationTime }),
      account,
      chainId,
      statement,
    );
    expect(err).toBe('');
    expect(ok).toBe(true);
  });
});
