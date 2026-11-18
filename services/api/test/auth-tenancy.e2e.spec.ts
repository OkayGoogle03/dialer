import { bearer, login, nextIp, ownerConnection, provision, RUN, startApp, TestApp, token } from './support/harness';

const PW_A = 'alpha-password-123';
const PW_B = 'bravo-password-456';
const A = `alpha-${RUN}`;
const B = `bravo-${RUN}`;

describe('API: auth, RBAC, tenant isolation (TiDB)', () => {
  let t: TestApp;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    t = await startApp();
    tenantA = (await provision(t.platformDb, A, `admin@${A}.test`, PW_A)).tenantId;
    tenantB = (await provision(t.platformDb, B, `admin@${B}.test`, PW_B)).tenantId;
  });

  afterAll(async () => t?.close());

  it('health endpoints respond', async () => {
    await t.http.get('/api/v1/health/live').expect(200, { status: 'ok' });
    const r = await t.http.get('/api/v1/health/ready').expect(200);
    expect(r.body.checks.database).toBe('ok');
  });

  it('rejects unauthenticated access with the standard error envelope', async () => {
    const r = await t.http.get('/api/v1/users').expect(401);
    expect(r.body.error).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(r.body.error.correlationId).toBeTruthy();
  });

  it('rejects invalid credentials and wrong-tenant logins identically', async () => {
    const results = [
      await login(t.http, A, `admin@${A}.test`, 'nope-nope-nope'),
      await login(t.http, B, `admin@${A}.test`, PW_A),
      await login(t.http, `nosuch-${RUN}`, `admin@${A}.test`, PW_A),
    ];
    for (const r of results) {
      expect(r.status).toBe(401);
      expect(r.body.error.message).toBe('Invalid credentials');
    }
  });

  it('validates request bodies', async () => {
    const r = await t.http.post('/api/v1/auth/login').set('X-Forwarded-For', nextIp()).send({ tenant: A, email: 'not-an-email', password: 'x', extra: 1 }).expect(400);
    expect(r.body.error.message).toBe('Validation failed');
  });

  it('logs in (case-insensitive email) and /me is scoped to the token tenant', async () => {
    const tok = await token(t.http, A, `Admin@${A.toUpperCase()}.test`, PW_A);
    const me = await t.http.get('/api/v1/auth/me').set(bearer(tok)).expect(200);
    expect(me.body.tenant.id).toBe(tenantA);
    expect(me.body.roles).toEqual(['tenant_admin']);
    expect(me.body.permissions).toContain('users:manage');
    expect(me.body.isPlatformAdmin).toBe(false);
    expect(me.body.branding.primaryColor).toMatch(/^#/);
  });

  it('web login sets an httpOnly refresh cookie and refresh works from the cookie', async () => {
    const r = await t.http.post('/api/v1/auth/login').set('X-Forwarded-For', nextIp()).send({ tenant: A, email: `admin@${A}.test`, password: PW_A }).expect(200);
    expect(r.body.refreshToken).toBeUndefined();
    const cookie = (r.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/dialer_rt=.*HttpOnly.*SameSite=Strict/i);
    const refreshed = await t.http.post('/api/v1/auth/refresh').set('Cookie', cookie.split(';')[0]).send({}).expect(200);
    expect(refreshed.body.accessToken).toBeTruthy();
  });

  it('refresh-token rotation detects reuse and revokes the family', async () => {
    const rt1 = (await login(t.http, A, `admin@${A}.test`, PW_A)).body.refreshToken as string;
    const rt2 = (await t.http.post('/api/v1/auth/refresh').send({ refreshToken: rt1 }).expect(200)).body.refreshToken as string;
    expect(rt2).not.toBe(rt1);
    await t.http.post('/api/v1/auth/refresh').send({ refreshToken: rt1 }).expect(401);
    await t.http.post('/api/v1/auth/refresh').send({ refreshToken: rt2 }).expect(401);
  });

  it('a refresh token cannot be replayed against another tenant id', async () => {
    const [, tokenId, secret] = ((await login(t.http, A, `admin@${A}.test`, PW_A)).body.refreshToken as string).split('.');
    await t.http.post('/api/v1/auth/refresh').send({ refreshToken: `${tenantB}.${tokenId}.${secret}` }).expect(401);
  });

  it('creates users in the caller tenant only and isolates listings', async () => {
    const a = await token(t.http, A, `admin@${A}.test`, PW_A);
    const b = await token(t.http, B, `admin@${B}.test`, PW_B);
    await t.http.post('/api/v1/users').set(bearer(a))
      .send({ email: `x@${A}.test`, displayName: 'X', password: 'longenough123', roles: ['agent'], tenantId: tenantB })
      .expect(400);
    const created = await t.http.post('/api/v1/users').set(bearer(a))
      .send({ email: `agent1@${A}.test`, displayName: 'Agent One', password: 'longenough123', roles: ['agent'] })
      .expect(201);
    expect(created.body.roles).toEqual(['agent']);

    const listA = await t.http.get('/api/v1/users').set(bearer(a)).expect(200);
    expect(listA.body.items.map((u: { email: string }) => u.email).sort()).toEqual([`admin@${A}.test`, `agent1@${A}.test`]);
    const listB = await t.http.get('/api/v1/users').set(bearer(b)).expect(200);
    expect(listB.body.items.map((u: { email: string }) => u.email)).toEqual([`admin@${B}.test`]);

    await t.http.get(`/api/v1/users/${created.body.id}`).set(bearer(b)).expect(404);
    await t.http.patch(`/api/v1/users/${created.body.id}`).set(bearer(b)).send({ status: 'disabled' }).expect(404);
    await t.http.post('/api/v1/users').set(bearer(a))
      .send({ email: `agent1@${A}.test`, displayName: 'Dup', password: 'longenough123', roles: ['agent'] })
      .expect(409);
  });

  it('enforces RBAC permissions for agents', async () => {
    const tok = await token(t.http, A, `agent1@${A}.test`, 'longenough123');
    const r = await t.http.get('/api/v1/users').set(bearer(tok)).expect(403);
    expect(r.body.error.message).toMatch(/users:read/);
    await t.http.put('/api/v1/branding').set(bearer(tok)).send({ primaryColor: '#000000' }).expect(403);
  });

  it('disabling a user blocks login and revokes refresh tokens', async () => {
    const admin = await token(t.http, A, `admin@${A}.test`, PW_A);
    const agentLogin = await login(t.http, A, `agent1@${A}.test`, 'longenough123');
    const list = await t.http.get('/api/v1/users?search=agent1').set(bearer(admin)).expect(200);
    await t.http.patch(`/api/v1/users/${list.body.items[0].id}`).set(bearer(admin)).send({ status: 'disabled' }).expect(200);
    expect((await login(t.http, A, `agent1@${A}.test`, 'longenough123')).status).toBe(401);
    await t.http.post('/api/v1/auth/refresh').send({ refreshToken: agentLogin.body.refreshToken }).expect(401);
  });

  it('updates branding and exposes it publicly for the login page', async () => {
    const admin = await token(t.http, A, `admin@${A}.test`, PW_A);
    await t.http.put('/api/v1/branding').set(bearer(admin)).send({ primaryColor: '#ff0000', logoUrl: 'http://insecure' }).expect(400);
    await t.http.put('/api/v1/branding').set(bearer(admin)).send({ primaryColor: '#ff0000', productName: 'Alpha Calls' }).expect(200);
    const pub = await t.http.get(`/api/v1/public/branding?tenant=${A}`).expect(200);
    expect(pub.body).toMatchObject({ tenantName: `${A} Ltd`, productName: 'Alpha Calls', primaryColor: '#ff0000' });
    await t.http.get(`/api/v1/public/branding?tenant=nosuch-${RUN}`).expect(404);
  });

  it('writes audit logs for security-relevant actions', async () => {
    const c = await ownerConnection();
    const [rows] = await c.query(`SELECT DISTINCT action FROM audit_logs WHERE tenant_id = ?`, [tenantA]);
    await c.end();
    expect((rows as { action: string }[]).map((r) => r.action)).toEqual(
      expect.arrayContaining(['tenant.provisioned', 'auth.login', 'auth.login_failed', 'auth.refresh_reuse_detected', 'user.created', 'user.updated', 'branding.updated']));
  });

  it('locks the account after repeated failed logins', async () => {
    for (let i = 0; i < 5; i++) await login(t.http, B, `admin@${B}.test`, 'wrong-password-x');
    expect((await login(t.http, B, `admin@${B}.test`, PW_B)).status).toBe(401);
  });

  it('rate-limits login attempts per client IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await login(t.http, `nosuch-${RUN}`, 'x@y.test', 'whatever', '192.0.2.77')).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('serves the OpenAPI document including Batch 2 routes', async () => {
    const r = await t.http.get('/api/docs/openapi.json').expect(200);
    expect(Object.keys(r.body.paths)).toEqual(expect.arrayContaining(['/api/v1/auth/login', '/api/v1/users', '/api/v1/roles', '/api/v1/teams', '/api/v1/platform/tenants']));
  });
});
