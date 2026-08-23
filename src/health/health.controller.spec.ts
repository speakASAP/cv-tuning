import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports the service name and status', () => {
    expect(new HealthController().check()).toEqual({ status: 'ok', service: 'cv-tuning' });
  });
});
