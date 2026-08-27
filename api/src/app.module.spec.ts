import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

jest.mock('@redis/client', () => {
  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue('OK'),
    isOpen: true,
    isReady: true,
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    setEx: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
    incr: jest.fn().mockResolvedValue(1),
    eval: jest.fn().mockResolvedValue(1),
    lPush: jest.fn().mockResolvedValue(1),
    lTrim: jest.fn().mockResolvedValue('OK'),
    expire: jest.fn().mockResolvedValue(true),
    scanIterator: jest.fn().mockReturnValue([]),
    unlink: jest.fn().mockResolvedValue(0),
    keys: jest.fn().mockResolvedValue([]),
  };
  return {
    createClient: jest.fn().mockReturnValue(mockClient),
  };
});

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation(() => ({
        simulateTransaction: jest.fn().mockResolvedValue({ result: { retval: {} }, events: [] }),
        prepareTransaction: jest.fn().mockImplementation((tx: unknown) => Promise.resolve(tx)),
        sendTransaction: jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'test-hash' }),
        getTransaction: jest.fn().mockResolvedValue({ status: 'NOT_FOUND' }),
      })),
    },
  };
});

describe('AppModule', () => {
  it(
    'should compile with all dependencies resolvable',
    async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      expect(moduleRef).toBeDefined();
      await moduleRef.close();
    },
    30_000,
  );
});
