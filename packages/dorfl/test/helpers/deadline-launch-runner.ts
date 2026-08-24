/**
 * A BARE runner process for the "does the runner survive its own deadline
 * reap?" regression (observation
 * `deadline-reap-lets-node-exit-0-before-the-checkpoint-runs`).
 *
 * It has to be its own process: the defect is that the event loop goes EMPTY
 * while the launch promise is unsettled, and node then exits normally. Inside
 * vitest that can never be observed, because the test runner's own handles keep
 * the loop alive — which is exactly why a full in-process suite for the deadline
 * reap existed and still missed this. So the assertion lives out here, in a
 * process whose loop is only as alive as the code under test keeps it.
 *
 * Contract with the parent test:
 *
 *  - `AFTER_AWAIT` is printed only if the `await` actually returned;
 *  - `FINALLY` is printed only if the surrounding `try/finally` ran (this stands
 *    in for the writer-sentinel release the real pipeline does there);
 *  - a silent exit prints NEITHER, which is the field symptom.
 */
import {PiHarness} from '../../src/pi-harness.js';

const [, , piBin, sessionFile, deadlineInMs] = process.argv;

async function runPipeline(): Promise<void> {
	const harness = new PiHarness({piBin});
	// Stands in for the claim/onboard preamble the field runs printed before
	// falling silent.
	console.log('PREAMBLE');
	try {
		const result = await harness.launchAsync({
			dir: process.cwd(),
			slug: 'deadline-runner',
			command: '',
			prompt: 'build it',
			session: sessionFile,
			deadlineMs: Date.now() + Number(deadlineInMs),
		});
		console.log(
			`AFTER_AWAIT timedOut=${result.timedOut === true} reaped=${
				result.reap?.reaped === true
			}`,
		);
	} finally {
		console.log('FINALLY');
	}
}

void runPipeline();
