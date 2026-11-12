# QUEUE-2f-final (VZ-FOUND-008) — resumable checklist
Branch fix/2f-joblog-timeout, base 56a4500.
- [x] F-A: timeout lines only in installed Playwright shapes (expect.js formatMatcherMessage `Timeout: ${timeout}ms`; worker `Test timeout of ${t}ms exceeded…`). No "Timed out … waiting for expect" string exists in installed source, so none is allowed.
- [x] F-B: scrubLocator strips quoted/regex args.
- [x] `--filter-log` stdin filter (default-deny) + tests; red: final-red.txt (5 failed), green: final-green.txt (29/29)
- [ ] e2e.yml: lane + docker logs piped through filter; pins updated
- [ ] check-e2e-lane.mjs refuses unfiltered lane/docker logs; require-checks_test cases
- [ ] e2e:demos (background) + regenerated digests, same commit as workflow
- [ ] lanes: require-checks_test, check-e2e-lane, hygiene, lint, typecheck, test
- [ ] CI failing-assertion proof (temp commit + revert), links
