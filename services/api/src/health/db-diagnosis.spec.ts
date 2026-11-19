import { diagnoseDbError } from './db-diagnosis';

describe('diagnoseDbError', () => {
  it('maps known codes to a hint', () => {
    expect(diagnoseDbError({ code: 'ER_ACCESS_DENIED_ERROR' })).toMatch(/^ER_ACCESS_DENIED_ERROR - .*DB_USER_PREFIX/);
    expect(diagnoseDbError({ code: 'ENOTFOUND' })).toMatch(/check DB_HOST/);
    expect(diagnoseDbError({ code: 'ETIMEDOUT' })).toMatch(/network access list/);
  });
  it('shows only the code for unknown codes and never leaks messages', () => {
    expect(diagnoseDbError({ code: 'SOMETHING_ELSE', message: "Access denied for user 'u'@'1.2.3.4'" })).toBe('SOMETHING_ELSE');
    expect(diagnoseDbError(new Error("password=hunter2 host=db.internal"))).toBe('UNKNOWN_ERROR');
    expect(diagnoseDbError({ code: 'bad code with spaces' })).toBe('UNKNOWN_ERROR');
    expect(diagnoseDbError(null)).toBe('UNKNOWN_ERROR');
  });
});
