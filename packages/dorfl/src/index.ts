export type {Brand} from './brand.js';
export {BASE, brand, deriveBrand, paramCase, constantCase} from './brand.js';

export type {
	Config,
	PartialConfig,
	IntegrationMode,
	HarnessAdapter,
	ReviewProviderName,
	VerifyConfig,
} from './config.js';
export {
	DEFAULT_CONFIG,
	mergeConfig,
	loadConfig,
	saveConfig,
	defaultConfigPath,
} from './config.js';

export type {
	RepoAllowedKey,
	RepoRejectedKey,
	LoadedRepoConfig,
	ResolveRepoConfigOptions,
	ResolvedRepoConfig,
} from './repo-config.js';
export {
	REPO_CONFIG_FILENAME,
	REPO_CONFIG_FILENAME_LEGACY,
	resolveRepoConfigPath,
	REPO_ALLOWED_KEYS,
	REPO_REJECTED_KEYS,
	repoConfigPath,
	loadRepoConfig,
	resolveRepoConfig,
} from './repo-config.js';

export type {
	ForwardDecision,
	ForwardOutcome,
	ForwardSpawn,
	ForwardSpawnResult,
	RepoCmdReader,
} from './bootstrap-forward.js';
export {
	FORWARDED_ENV_MARKER,
	NO_FORWARD_ENV,
	NO_FORWARD_FLAG,
	decideForward,
	performForward,
	maybeForward,
	defaultRepoCmdReader,
	defaultForwardSpawn,
	forwardNotice,
	forwardFailureMessage,
	argvHasNoForward,
	envHasNoForward,
	envIsForwarded,
	stripNoForwardFlag,
} from './bootstrap-forward.js';

export type {ConfigOverrideMap} from './config-override.js';
export {
	defaultConfigOverridePath,
	loadConfigOverride,
} from './config-override.js';

export type {EnvMap} from './env-config.js';
export {ENV_PREFIX, envVarName, envOverrides} from './env-config.js';

export type {
	RenderTaskBodyInput,
	RenderSpecBodyInput,
} from './buildable-body.js';
export {renderTaskBody, renderSpecBody} from './buildable-body.js';

export type {Frontmatter} from './frontmatter.js';
export {
	parseFrontmatter,
	setNeedsAnswersMarker,
	setFrontmatterMarker,
} from './frontmatter.js';

export type {
	SidecarType,
	SidecarEntry,
	SidecarModel,
	SidecarIdentity,
	NewQuestion,
} from './sidecar.js';
export {
	SidecarParseError,
	isEntryAnswered,
	pendingEntries,
	allAnswered,
	resolveSidecarIdentity,
	sidecarPathFor,
	sidecarPathCandidates,
	parseSidecar,
	serialiseSidecar,
	appendQuestions,
	newSidecar,
} from './sidecar.js';

export type {
	ApplyMode,
	ApplyAtomicOptions,
	ApplyAtomicResult,
} from './sidecar-apply.js';
export {ApplyAtomicError, applyAtomic} from './sidecar-apply.js';

export type {
	ApplyTerminal,
	ApplyAnsweredQuestionsOptions,
	ApplyAnsweredQuestionsResult,
} from './apply-persist.js';
export {ApplyPersistError, applyAnsweredQuestions} from './apply-persist.js';

export type {MintAdrOptions, MintAdrResult} from './mint-adr.js';
export {MintAdrError, mintAdr, buildAdrBody, adrItemRel} from './mint-adr.js';

export {
	APPLY_LIFECYCLE_FOLDERS,
	resolveItemPathByIdentity,
} from './item-path.js';

export type {
	DropSourceOptions,
	DropSourceResult,
	DropTerminal,
} from './drop-source.js';
export {DropSourceError, dropSource} from './drop-source.js';

export type {
	TickItem,
	TickRungKind,
	TickClassification,
} from './advance-classify.js';
export {classifyTick, isAdvanceable} from './advance-classify.js';

export {isParticipatingRepo, findParticipatingRepos} from './detect.js';

export type {
	HumanOnlyGate,
	BlockedByResult,
	EligibilityInput,
	EligibilityResult,
} from './eligibility.js';
export {
	resolveGate,
	resolveBlockedBy,
	resolveEligibility,
} from './eligibility.js';

export type {
	TaskedAfterResult,
	TaskingEligibilityInput,
	TaskingEligibilityResult,
} from './tasking-eligibility.js';
export {
	resolveTaskGate,
	resolveTaskedAfter,
	resolveTaskingEligibility,
} from './tasking-eligibility.js';

export type {
	LedgerReadyItem,
	LedgerObservationItem,
	LedgerSpecItem,
	LedgerSpecPool,
	SpecExistence,
	LocalLedgerState,
	ArbiterLedgerState,
	ResolveLocalStateInput,
	ResolveSpecExistenceInput,
	ResolveSpecPoolInput,
	ResolveArbiterStateInput,
	ResolveMirrorStateInput,
	LedgerReadStrategy,
} from './ledger-read.js';
export {currentLedgerRead, ledgerRead} from './ledger-read.js';

export type {
	SpecCompleteInput,
	SpecTask,
	SpecCompleteResult,
} from './spec-complete.js';
export {isSpecComplete} from './spec-complete.js';

export type {
	LedgerTransitionKind,
	ApplyTransitionInput,
	ApplyTransitionResult,
	ApplyCompleteTransitionInput,
	ApplyCompleteTransitionResult,
	ApplyNeedsAttentionTransitionInput,
	ApplyNeedsAttentionTransitionResult,
	ApplyReturnToBacklogTransitionInput,
	ApplyReturnToBacklogTransitionResult,
	LedgerWriteStrategy,
} from './ledger-write.js';
export {currentLedgerWrite, ledgerWrite} from './ledger-write.js';

export type {ReadyItem, ScannedItem, RepoReport, ScanReport} from './scan.js';
export {scan, scanRepoPaths, readReadyItems, readDoneSlugs} from './scan.js';

export type {
	SlugNamespace,
	ParsedSlugArg,
	ResolvedSlug,
	ResolveSlugInput,
} from './slug-namespace.js';
export {
	SlugResolutionError,
	parseSlugArg,
	resolveSlug,
	resolveTaskOnlyArg,
} from './slug-namespace.js';

export type {
	RegisteredMirror,
	Transport,
	RegistryOptions,
	RemoteAddResult,
	RemoteAddOptions,
	RemoteRmResult,
	RemoteRmOptions,
} from './registry.js';
export {
	RegistryError,
	listMirrors,
	remoteAdd,
	remoteRm,
	transportForUrl,
	projectIdFromKey,
} from './registry.js';

export {formatReport, formatCwdSection, gateLabel} from './format.js';
export type {
	CwdSection,
	CwdArbiter,
	ResolveCwdSectionOptions,
	CwdDisposition,
} from './cwd-section.js';
export {resolveCwdSection, cwdSectionDisposition} from './cwd-section.js';

export type {
	TaskFolder,
	ResolvedTask,
	PromptOptions,
	ContinueContext,
	ContinueResolutionGate,
} from './prompt.js';
export {
	extractPromptSection,
	extractCanonicalWrapperTemplate,
	resolveProtocolDoc,
	wrapper,
	buildAgentPrompt,
	buildContinueBlock,
	extractRequeueNotes,
	resolveContinueContext,
	resolveTask,
	inferSlugFromBranch,
	renderPrompt,
	PromptError,
} from './prompt.js';

export type {Candidate, SelectCaps} from './select.js';
export {selectCandidates} from './select.js';

export type {
	SelectedNamespace,
	SelectedItem,
	LifecycleSelectedItem,
	SelectedLifecyclePools,
	SpecCandidate,
	TaskableSpecsInput,
	SelectPrioritisedInput,
} from './select-priority.js';
export {taskableSpecs, selectPrioritised} from './select-priority.js';

export type {
	ClaimExitCode,
	ClaimCasOutcome,
	ClaimCasOptions,
	ClaimCasResult,
} from './claim-cas.js';
export {performClaim} from './claim-cas.js';

export type {
	AcquireAdvancingLockOutcome,
	AcquireAdvancingLockExitCode,
	AcquireAdvancingLockOptions,
	AcquireAdvancingLockResult,
	ReleaseAdvancingLockOutcome,
	ReleaseAdvancingLockExitCode,
	ReleaseAdvancingLockOptions,
	ReleaseAdvancingLockResult,
	CreateItemOutcome,
	CreateItemExitCode,
	CreateItemThroughCasOptions,
	CreateItemThroughCasResult,
	CasContentionBudget,
	CasAttemptResult,
	CasContentionLoopResult,
} from './advancing-lock.js';
export {
	acquireAdvancingLock,
	releaseAdvancingLock,
	createItemThroughCas,
	nextCasContentionDelayMs,
	runCasContentionLoop,
	INTERACTIVE_CAS_CONTENTION,
	LIFECYCLE_CAS_CONTENTION,
} from './advancing-lock.js';

export type {
	LockAction,
	LockState,
	LockEntry,
	AcquireOutcome,
	ReleaseOutcome,
	AcquireResult,
	ReleaseResult,
	AcquireOptions,
	ReleaseOptions,
	ReconcileOutcome,
	ReconcileResult,
	ReleaseHeldOutcome,
	ReleaseHeldResult,
	LockReportEntry,
	ItemLockReport,
} from './item-lock.js';
export {
	LOCK_REF_PREFIX,
	lockEntryFor,
	itemLockRef,
	acquireItemLock,
	releaseItemLock,
	releaseHeldItemLock,
	readItemLock,
	reconcileItemLockAgainstMain,
	reconcileTerminalItemLocks,
	classifyTerminalItemLocks,
	classifyItemLockAgainstMain,
	reportItemLocks,
	formatItemLockReport,
	itemLockReportNeedsAttention,
	itemFromLockEntry,
	terminalMainPaths,
	listItemLocks,
	listItemLockEntries,
	heldTaskSlugs,
	resolveLockHolder,
	serialiseLockEntry,
	parseLockEntry,
} from './item-lock.js';

export type {StartOutcome, StartOptions, StartResult} from './start.js';
export {performStart} from './start.js';

export type {WorkOnOutcome, WorkOnOptions, WorkOnResult} from './work-on.js';
export {
	performWorkOn,
	suggestHumanWorktreesDir,
	loadHumanWorktreesDir,
	persistHumanWorktreesDir,
} from './work-on.js';

export type {ReadinessVerdict, ResolveReadinessOptions} from './readiness.js';
export {resolveReadiness} from './readiness.js';

export type {
	CompleteOutcome,
	CompleteOptions,
	CompleteResult,
} from './complete.js';
export {performComplete} from './complete.js';

export type {
	RecoverIsolatedOutcome,
	RecoverIsolatedOptions,
	RecoverIsolatedResult,
} from './recover-isolated.js';
export {
	performRecoverIsolated,
	locateIsolatedRecovery,
} from './recover-isolated.js';

export type {
	DoOutcome,
	DoResult,
	DoDorfl,
	DoOptions,
	DoRemoteOptions,
} from './do.js';
export {performDo, performDoRemote} from './do.js';

export type {
	DoRunner,
	PerformDoMultiOptions,
	DoMultiResult,
} from './do-autopick.js';
export {performDoAuto, performDoArgs} from './do-autopick.js';

export type {
	TaskOutcome,
	TaskResult,
	TaskDorfl,
	TaskingLockSeam,
	PerformTaskOptions,
} from './tasking.js';
export {performTask} from './tasking.js';

export type {
	Issue,
	IssueComment,
	GetIssueInput,
	ListCommentsInput,
	PostIssueCommentInput,
	PostIssueCommentResult,
	IssueProvider,
	GitHubIssueProviderOptions,
} from './issue-provider.js';
export {GitHubIssueProvider} from './issue-provider.js';

export type {
	IntakeOutcome,
	IntakeVerdict,
	IntakeRunOutcome,
	IntakeResult,
	IntakeDecider,
	PerformIntakeOptions,
} from './intake.js';
export {performIntake, buildIntakeDecisionSpec} from './intake.js';

export type {
	DecisionOutcome,
	DecisionVerdict,
	DecisionDecider,
} from './decision-engine.js';
export {
	decide,
	parseDecisionVerdict,
	DisallowedOutcomeError,
	EmptyAllowedOutcomesError,
} from './decision-engine.js';

export type {
	IntakeEventKind,
	IntakeEventDecision,
	IntakeEvent,
} from './intake-event.js';
export {classifyIntakeEvent} from './intake-event.js';

export type {IntakeMarker, IntakeMarkerKind} from './intake-marker.js';
export {
	stampIntakeMarker,
	parseIntakeMarker,
	isIntakeComment,
	computeSeenDelta,
	seenSetFrom,
} from './intake-marker.js';
export type {IntakeTriageDecision} from './intake-triage.js';
export {triageIntake} from './intake-triage.js';

export type {EnsureMirrorOptions, EnsureMirrorResult} from './repo-mirror.js';
export {
	encodeRepoKey,
	mirrorPath,
	ensureMirror,
	fetchMirrorMain,
	mirrorMainSha,
	resolveRepoConfigFromMirror,
} from './repo-mirror.js';

export type {
	ScanMirrorPoolOptions,
	MirrorPoolScanResult,
} from './mirror-pool-scan.js';
export {scanMirrorPool} from './mirror-pool-scan.js';

export type {
	LifecyclePoolGates,
	LifecyclePools,
	LifecyclePoolsInput,
	NeedsAnswersCandidate,
	ObservationCandidate,
} from './lifecycle-pools.js';
export {buildLifecyclePools} from './lifecycle-pools.js';
export {
	gatherLifecycleInPlace,
	gatherLifecycleMirror,
} from './lifecycle-gather.js';

export type {JobRecord, JobState, CreateJobOptions, Job} from './workspace.js';
export {
	JOB_RECORD_FILENAME,
	jobRecordPath,
	encodeWorkId,
	jobWorktreePath,
	createJob,
	writeJobRecord,
	readJobRecord,
	updateJobRecord,
	removeJobRecord,
} from './workspace.js';

export type {
	HarnessRecord,
	LaunchInput,
	LaunchResult,
	Harness,
} from './harness.js';
export {
	NullHarness,
	pidAlive,
	resolveHarness,
	registerHarness,
} from './harness.js';

export type {PiHarnessOptions, PiHarnessRecord} from './pi-harness.js';
export {
	PiHarness,
	createHarness,
	piSessionExists,
	DEFAULT_PI_BIN,
} from './pi-harness.js';

export type {GenerateSessionPathInput} from './session-path.js';
export {generateSessionPath, piDefaultSessionDir} from './session-path.js';

export type {SessionTailerOptions} from './watch-session.js';
export {
	formatWatchEvent,
	finishedLine,
	boundaryLine,
	SessionTailer,
} from './watch-session.js';

export type {LaunchWithOptionalWatchInput} from './agent-launch.js';
export {launchWithOptionalWatch} from './agent-launch.js';

export type {
	ReviewProvider,
	OpenRequestInput,
	OpenRequestResult,
	IntegrateInput,
	IntegrateResult,
	IntegrateWithRebaseResult,
	IntegratorOptions,
	RebaseInput,
	RebaseResult,
} from './integrator.js';
export {
	Integrator,
	NoneProvider,
	rebaseOntoArbiterMain,
	arbiterMainContains,
} from './integrator.js';

export type {
	ProviderName,
	SelectProviderOptions,
	GitHubProviderOptions,
} from './github.js';
export {
	GitHubProvider,
	isGitHubArbiterUrl,
	selectProvider,
	DEFAULT_GH_BIN,
} from './github.js';

export type {
	IsolatedTree,
	PrepareInput,
	IsolationStrategy,
	SelectIsolationInput,
} from './isolation.js';
export {
	jobWorktreeStrategy,
	jobWorktreeHandle,
	inPlaceStrategy,
	selectIsolationStrategy,
} from './isolation.js';

export type {
	ItemStatus,
	ItemResult,
	RunOnceResult,
	RunOnceOptions,
	Dorfl,
} from './run.js';
export {runOnce, defaultRunWorkspace} from './run.js';

export type {RunVerifyOptions, RunVerifyResult} from './verify.js';
export {
	runVerify,
	resolveVerifyCommands,
	VerifyNotConfiguredError,
	VERIFY_NOT_CONFIGURED_MESSAGE,
} from './verify.js';

export type {
	PrepareConfig,
	RunPrepareOptions,
	RunPrepareResult,
	EnsurePreparedOptions,
} from './prepare.js';
export {
	runPrepare,
	resolvePrepareCommands,
	ensurePrepared,
	isPrepared,
	markPrepared,
	preparedMarkerPath,
	PREPARE_MARKER_BASENAME,
} from './prepare.js';

export type {
	ReviewFinding,
	ReviewVerdict,
	ReviewGateInput,
	ReviewGate,
	HarnessReviewGateOptions,
} from './review-gate.js';
export {
	ReviewParseError,
	parseReviewVerdict,
	buildReviewPrompt,
	buildTaskAcceptancePrompt,
	harnessReviewGate,
	harnessTaskAcceptanceGate,
	formatBlockReason,
	reviewRoundsExhaustedReason,
} from './review-gate.js';

export type {
	RetainReason,
	ReachableVia,
	SafetyVerdict,
	EvaluateSafetyInput,
	ReapInput,
	ReapResult,
	GcJob,
	ReapedJob,
	RetainedJob,
	GcOptions,
	GcResult,
} from './gc.js';
export {
	RETAIN_REASON_TEXT,
	evaluateDeletionSafety,
	reapJob,
	gc,
	discoverJobs,
} from './gc.js';
export type {
	ReapedSidecar,
	RetainedSidecar,
	SweepOrphanSidecarsInput,
	SweepOrphanSidecarsResult,
} from './orphan-sidecar.js';
export {sweepOrphanSidecars} from './orphan-sidecar.js';

export type {
	VocabularyMigration,
	QuiescenceViolation,
	ResyncedDoc,
	ResyncResult,
	FolderMove,
	ContentRewrite,
	ConfigRewrite,
	RefRename,
	DataLeak,
	PrdToSpecOptions,
	PrdToSpecResult,
} from './prd-to-spec.js';
export {
	MIGRATION,
	PROTOCOL_DOCS,
	keepCaseReplace,
	checkQuiescence,
	resyncProtocol,
	migrateFolders,
	migrateItemContent,
	migrateAllItemContent,
	migrateConfig,
	migrateRefs,
	scanForLeaks,
	runPrdToSpec,
} from './prd-to-spec.js';

export type {JobStatus, StatusReport, StatusOptions} from './status.js';
export {status, formatStatus} from './status.js';

export type {
	ArbiterInitOptions,
	ArbiterInitResult,
	ArbiterStatusOptions,
	ArbiterStatusReport,
} from './arbiter.js';
export {
	DEFAULT_ARBITER_REMOTE,
	ArbiterError,
	arbiterPath,
	arbiterInit,
	arbiterStatus,
	formatArbiterStatus,
} from './arbiter.js';

export type {
	RouteToNeedsAttentionOptions,
	RouteToNeedsAttentionResult,
	ReturnToBacklogOptions,
	ReturnToBacklogResult,
} from './needs-attention.js';
export {
	routeToNeedsAttention,
	returnToBacklog,
	extractReason,
} from './needs-attention.js';

export type {
	Category,
	CategorisedItem,
	CategorisedGroups,
	CategorySummary,
} from './categorise.js';
export {
	categoriseItem,
	categoriseItems,
	sortReadyFirst,
	summariseGroups,
	CATEGORY_ORDER,
	CATEGORY_LABELS,
} from './categorise.js';

export type {
	AdvanceCiTemplateProblem,
	AdvanceCiTemplateValidation,
} from './advance-ci-template.js';
export {
	resolveAdvanceCiTemplatePath,
	loadAdvanceCiTemplate,
	validateAdvanceCiTemplate,
} from './advance-ci-template.js';

export type {
	CloseJobProblem,
	CloseJobValidation,
} from './close-job-template.js';
export {
	CLOSE_JOB_CAPABILITY_ID,
	CLOSE_JOB_CAPABILITY_LABEL,
	CLOSE_JOB_WORKFLOW_PATH,
	generateCloseJobWorkflow,
	validateCloseJobWorkflow,
} from './close-job-template.js';

export type {
	CloseDecision,
	CloseCandidate,
	CloseJobResult,
	CloseJobOptions,
	PerformCloseMergedIssuesOptions,
} from './close-job.js';
export {runCloseJob, performCloseMergedIssues} from './close-job.js';

export type {
	AuthMode,
	ProviderEntry,
	CIConfigFile,
	ResolvedCIConfig,
	CIProviderContext,
	GitHubCIContext as GitHubCIContextType,
	EmittedFile,
	CapabilityEmitter,
	SecretSetResult,
} from './install-ci-core.js';
export {
	DEFAULT_HARNESS,
	CIConfigError,
	registerCapability,
	registeredCapabilities,
	clearCapabilityRegistry,
	resolveCapabilitiesDir,
	loadCapabilityRegistry,
	buildModelsJson,
	requiredSecretNames,
	optionalSecretNames,
	PR_IDENTITY_SECRET_NAME,
	providerSecretsWithBlock,
	orchestrateSecrets,
	loadCIConfigFile,
	resolveCIConfig,
	exportCIConfig,
	generateSetupAction,
	REFRESH_OAUTH_SCRIPT,
	buildSetupArtifacts,
	outputBaseName,
	writeArtifacts,
} from './install-ci-core.js';

export type {GitHubCIContextOptions} from './install-ci-github.js';
export {GitHubCIContext, MemoryCIProviderContext} from './install-ci-github.js';

export type {
	WizardPrompts,
	InstallCIOptions,
	InstallCIResult,
} from './install-ci.js';
export {installCI, runWizard} from './install-ci.js';

export type {
	InstallSkillsOptions,
	InstallSkillsResult,
	InstalledAgent,
} from './install-skills.js';
export {installSkills, resolveSkillsSourceDir} from './install-skills.js';
export type {Agent} from './vendor/incur/agents.js';
