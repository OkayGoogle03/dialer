import { classifyOutcome } from './call-outcome';

const failed = (sipCode: number | null, cause: string, rang = false) => classifyOutcome({ final: 'failed', answered: false, rang, cause, sipCode });

describe('call outcome: Success when the phone was reached, Not success when it never rang', () => {
  it('answered calls are Success and say who ended them', () => {
    expect(classifyOutcome({ final: 'completed', answered: true, rang: true, cause: 'Called party disconnected', seconds: 42 }))
      .toEqual({ status: 'success', note: 'Call answered; the user disconnected the call after 42s' });
    expect(classifyOutcome({ final: 'completed', answered: true, rang: true, cause: 'Agent ended the call', seconds: 7 }).note).toMatch(/agent ended/);
  });

  it('ringing but unanswered / cancelled while ringing is Success', () => {
    expect(classifyOutcome({ final: 'completed', answered: false, rang: true, cause: 'No answer within 5 s (ring limit)' })).toMatchObject({ status: 'success', note: expect.stringMatching(/rang but the user did not answer/) });
    expect(classifyOutcome({ final: 'completed', answered: false, rang: true, cause: 'Agent ended the call' })).toMatchObject({ status: 'success', note: expect.stringMatching(/cancelled before the user answered/) });
  });

  it('busy / on another call / declined are Success with the user action', () => {
    expect(failed(486, 'Busy Here')).toMatchObject({ status: 'success', note: expect.stringMatching(/busy or on another call.*486/) });
    expect(failed(600, 'Busy Everywhere').status).toBe('success');
    expect(failed(603, 'Declined')).toMatchObject({ status: 'success', note: expect.stringMatching(/declined \/ disconnected.*603/) });
    expect(failed(null, 'Busy').status).toBe('success');
    expect(failed(null, 'Rejected').status).toBe('success');
  });

  it('switched off / not reachable / not found / server problems are Not success with the reason', () => {
    expect(failed(480, 'Temporarily Unavailable')).toMatchObject({ status: 'not_success', note: expect.stringMatching(/switched off or not reachable.*480/) });
    expect(failed(404, 'Not Found').note).toMatch(/number not found/);
    expect(failed(408, 'Request Timeout').note).toMatch(/did not respond/);
    expect(failed(403, 'Forbidden').note).toMatch(/refused this SIP account/);
    expect(failed(401, 'Unauthorized').status).toBe('not_success');
    expect(failed(503, 'Service Unavailable').note).toMatch(/server or carrier problem/);
    expect(failed(488, 'Not Acceptable Here').note).toMatch(/codec/);
    expect(failed(null, 'Connection Error').note).toMatch(/server or network problem/);
    expect(failed(null, 'User Denied Media Access').note).toMatch(/audio problem/);
    expect(failed(null, 'something odd')).toEqual({ status: 'not_success', note: 'Not connected: something odd' });
  });

  it('cancelling before the phone rang is Not success', () => {
    expect(classifyOutcome({ final: 'completed', answered: false, rang: false, cause: 'Agent ended the call' })).toEqual({ status: 'not_success', note: 'Call cancelled before the phone started ringing' });
    expect(failed(487, 'Request Terminated', false).status).toBe('not_success');
    expect(failed(487, 'Request Terminated', true).status).toBe('success');
  });
});
