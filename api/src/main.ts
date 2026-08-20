import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      validationError: { target: false, value: false },
    }),
  );
  // Enable NestJS lifecycle shutdown hooks so that OnModuleDestroy /
  // OnApplicationShutdown callbacks are invoked when the process receives
  // SIGTERM or SIGINT (e.g. Kubernetes pod termination, `docker stop`).
  // Without this call, Redis connections are abandoned and in-flight
  // transactions are left incomplete on process exit.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT || 3000);
}
bootstrap();
