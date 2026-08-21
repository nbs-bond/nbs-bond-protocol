import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { createHash } from 'crypto';

const HORIZON_URL = process.env.STELLAR_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;
const METHODOLOGY = 'VERRA-VCS';
const BOND_ID = 1n;

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.includes('...')) throw new Error(`${name} must be set`);
  return value;
}

const PROJECT_REGISTRY_ID = required('PROJECT_REGISTRY_ADDRESS');
const BOND_ISSUER_ID = required('BOND_ISSUER_ADDRESS');
const COUPON_ENGINE_ID = required('COUPON_ENGINE_ADDRESS');
const ORACLE_CONSUMER_ID = required('ORACLE_CONSUMER_ADDRESS');

const horizon = new Horizon.Server(HORIZON_URL);
const soroban = new rpc.Server(RPC_URL);

const u64 = (value: bigint | number) => nativeToScVal(BigInt(value), { type: 'u64' });
const i128 = (value: bigint | number) => nativeToScVal(BigInt(value), { type: 'i128' });
const symbol = (value: string) => nativeToScVal(value, { type: 'symbol' });
const address = (value: string) => Address.fromString(value).toScVal();
const bytes32 = (label: string) => xdr.ScVal.scvBytes(createHash('sha256').update(label).digest());
const enumValue = (variant: string) => xdr.ScVal.scvVec([symbol(variant)]);
const struct = (fields: Record<string, xdr.ScVal>) => xdr.ScVal.scvMap(
  Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) =>
    new xdr.ScMapEntry({ key: symbol(key), val: value })),
);

async function read(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<unknown> {
  const source = new Account(Keypair.random().publicKey(), '0');
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const simulation = await soroban.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation) || !simulation.result) {
    throw new Error(`Could not read ${method}: ${rpc.Api.isSimulationError(simulation) ? simulation.error : 'no result'}`);
  }
  return scValToNative(simulation.result.retval);
}

async function exists(contractId: string, method: string, args: xdr.ScVal[]): Promise<boolean> {
  try {
    await read(contractId, method, args);
    return true;
  } catch {
    return false;
  }
}

async function invoke(
  signer: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const horizonAccount = await horizon.loadAccount(signer.publicKey());
  const source = new Account(signer.publicKey(), horizonAccount.sequence);
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const simulation = await soroban.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`${method} simulation failed: ${simulation.error}`);
  }
  const prepared = await soroban.prepareTransaction(tx);
  prepared.sign(signer);
  const sent = await soroban.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error(`${method} submission failed`);

  for (;;) {
    const result = await soroban.getTransaction(sent.hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      console.log(`  ${method} (tx: ${sent.hash})`);
      return simulation.result ? scValToNative(simulation.result.retval) : undefined;
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`${method} failed on-chain (tx: ${sent.hash})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function fund(keypair: Keypair): Promise<void> {
  try {
    await horizon.loadAccount(keypair.publicKey());
    console.log(`  Already funded ${keypair.publicKey()}`);
  } catch {
    await horizon.friendbot(keypair.publicKey()).call();
    console.log(`  Funded ${keypair.publicKey()}`);
  }
}

async function main() {
  const admin = Keypair.fromSecret(required('ADMIN_SECRET_KEY'));
  const provider = Keypair.fromSecret(required('USER_SECRET_KEY'));
  const verifier = Keypair.fromSecret(required('INVESTOR_SECRET_KEY'));
  if (new Set([admin.publicKey(), provider.publicKey(), verifier.publicKey()]).size !== 3) {
    throw new Error('ADMIN_SECRET_KEY, USER_SECRET_KEY, and INVESTOR_SECRET_KEY must be distinct');
  }

  console.log('🌱 Seeding testnet with sample data...\n');
  for (const keypair of [admin, provider, verifier]) await fund(keypair);

  const projectHash = bytes32('nbs-seed:amazon-reforestation-corridor');
  let projectId = projectHash;

  if (await exists(BOND_ISSUER_ID, 'get_bond', [u64(BOND_ID)])) {
    const bond = await read(BOND_ISSUER_ID, 'get_bond', [u64(BOND_ID)]) as { project_id: Buffer };
    projectId = xdr.ScVal.scvBytes(Buffer.from(bond.project_id));
    console.log(`\n  Bond ${BOND_ID} already exists; skipping project and bond registration`);
  } else {
    console.log('\n📋 Registering project...');
    await invoke(admin, PROJECT_REGISTRY_ID, 'register_project', [
      address(admin.publicKey()), projectHash, symbol(METHODOLOGY), symbol('BR'), u64(0),
    ]);

    const now = Math.floor(Date.now() / 1000);
    const config = struct({
      coupon_schedule: xdr.ScVal.scvVec([u64(now + 90 * 86_400), u64(now + 180 * 86_400)]),
      credit_type: enumValue('Carbon'),
      face_value: i128(100_000_000_000n),
      maturity_date: u64(now + 365 * 86_400),
      project_id: projectHash,
      total_supply: i128(1_000),
    });
    console.log('\n💰 Issuing bond tranche...');
    await invoke(admin, BOND_ISSUER_ID, 'issue_bond', [address(admin.publicKey()), config, u64(0)]);
  }

  if (await exists(COUPON_ENGINE_ID, 'get_bond_credit_type', [u64(BOND_ID)])) {
    console.log(`  Bond ${BOND_ID} is already registered with the coupon engine; skipping`);
  } else {
    await invoke(admin, COUPON_ENGINE_ID, 'register_bond', [
      address(admin.publicKey()), u64(BOND_ID), projectId, u64(0),
    ]);
  }

  console.log('\n🔭 Registering independent oracle providers...');
  const providers = [provider, verifier];
  let adminNonce = 0;
  for (const keypair of providers) {
    if (await exists(ORACLE_CONSUMER_ID, 'get_provider', [address(keypair.publicKey())])) {
      console.log(`  Provider ${keypair.publicKey()} already exists; skipping`);
      adminNonce += 1;
      continue;
    }
    await invoke(admin, ORACLE_CONSUMER_ID, 'register_provider', [
      address(admin.publicKey()), address(keypair.publicKey()), symbol(METHODOLOGY), u64(adminNonce),
    ]);
    adminNonce += 1;
  }

  const existingReportIds = await read(ORACLE_CONSUMER_ID, 'get_project_reports', [projectId]) as bigint[];
  let reportId: bigint | undefined;
  for (const candidateId of existingReportIds) {
    const candidate = await read(ORACLE_CONSUMER_ID, 'get_report', [u64(candidateId)]) as {
      methodology: string;
      provider: string;
    };
    if (candidate.methodology === METHODOLOGY && candidate.provider === provider.publicKey()) {
      reportId = BigInt(candidateId);
      break;
    }
  }
  if (reportId !== undefined) {
    console.log(`\n  Project report ${reportId} already exists; skipping submission`);
  } else {
    console.log('\n📡 Submitting non-zero carbon report...');
    const now = Math.floor(Date.now() / 1000);
    reportId = BigInt(await invoke(provider, ORACLE_CONSUMER_ID, 'submit_report', [
      address(provider.publicKey()), projectId, u64(now - 30 * 86_400), u64(now),
      i128(250_000), enumValue('Absent'), symbol(METHODOLOGY),
      bytes32('nbs-seed:oracle-evidence'), u64(0),
    ]) as bigint);
  }

  const report = await read(ORACLE_CONSUMER_ID, 'get_report', [u64(reportId)]) as { status: unknown };
  const status = Array.isArray(report.status) ? report.status[0] : report.status;
  if (status === 'Verified') {
    console.log(`  Report ${reportId} is already verified; skipping verification`);
  } else {
    console.log('\n✅ Verifying report with the second provider...');
    await invoke(verifier, ORACLE_CONSUMER_ID, 'verify_report', [
      address(verifier.publicKey()), u64(reportId), u64(0),
    ]);
  }

  if (!(await exists(BOND_ISSUER_ID, 'get_bond_state', [u64(BOND_ID)]))) {
    throw new Error(`Bond ${BOND_ID} was not created`);
  }
  const investorBalance = BigInt(await read(BOND_ISSUER_ID, 'get_holder_balance', [
    u64(BOND_ID), address(verifier.publicKey()),
  ]) as bigint);
  if (investorBalance > 0n) {
    console.log(`\n  Investor already holds ${investorBalance} bond tokens; skipping subscription`);
  } else {
    console.log('\n👤 Subscribing test investor...');
    await invoke(verifier, BOND_ISSUER_ID, 'subscribe', [
      address(verifier.publicKey()), u64(BOND_ID), i128(10), u64(0),
    ]);
  }

  console.log(`\n✅ Seeding complete — verified report ${reportId} contains 250,000 kg CO2e (250 carbon credits).`);
}

main().catch((error) => {
  console.error('❌ Seed script failed:', error);
  process.exitCode = 1;
});
