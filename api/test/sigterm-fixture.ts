/**
 * sigterm-fixture.ts
 *
 * Subprocess fixture for the SIGTERM integration test.
 *
 * Starts a minimal NestJS application with enableShutdownHooks(), writes a
 * "ready" marker to stdout, then waits for SIGTERM. When the signal arrives,
 * onModuleDestroy (via callDestroyHook) fires and writes "destroyed" to stdout
 * before the process exits.
 *
 * Usage (from the test suite):
 *   const proc = spawn('npx', ['ts-node', '-P', 'tsconfig.json', 'test/sigterm-fixture.ts']);
 *   // wait for "ready" line, send SIGTERM, expect "destroyed" line
 */

import { NestFactory } from '@nestjs/core';
import { Module, Injectable, OnModuleDestroy } from '@nestjs/common';

@Injectable()
class ProbeService implements OnModuleDestroy {
  onModuleDestroy() {
    // This must be written synchronously — after onModuleDestroy, NestJS calls
    // dispose() which closes the HTTP server, and then process.kill(pid, signal)
    // is called to actually kill the process.
    process.stdout.write(JSON.stringify({ event: 'destroyed' }) + '\n');
  }
}

@Module({
  providers: [ProbeService],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(0);
  process.stdout.write(JSON.stringify({ event: 'ready', port: app.getHttpServer().address().port }) + '\n');
}

bootstrap().catch((err) => {
  process.stderr.write('BOOTSTRAP_ERROR: ' + String(err?.message ?? err) + '\n');
  process.exit(1);
});