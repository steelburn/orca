// Settings → Privacy → Diagnostics. Source: telemetry-error-tracking.md
// §User controls.
//
//   Open trace folder              — reveals the NDJSON file in the OS file
//                                    manager (precedent: Aider's published
//                                    sample log; this is the live equivalent).
//   Clear local traces             — wipes the rotated family. Useful before
//                                    handing a laptop to a colleague.
//   Share a diagnostic bundle      — Mode 3 button. Opens preview, then
//                                    confirms upload via the two-step token
//                                    flow.
//   OTLP export                    — display-only status (env-var-driven, set
//                                    ORCA_OTLP_TRACES_URL and restart).
//
// Renderer-side flow for "Share a diagnostic bundle":
//   1. Click → main collects + redacts → preview text returned.
//   2. <textarea> shows the preview verbatim. User can edit, copy, cancel.
//   3. Confirm → main does two-step token + upload → ticket ID returned.
//   4. Ticket ID rendered with "Copy" + "Done" controls.

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Folder, Trash2, FileText, Globe, Copy, Check } from 'lucide-react'
import type { SettingsSearchEntry } from './settings-search'
import type {
  DiagnosticsBundlePayload,
  DiagnosticsStatusPayload,
  DiagnosticsUploadPayload
} from '../../../../preload/api-types'

export const PRIVACY_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Open trace folder',
    description: 'Reveal the local diagnostic trace file in your file manager.',
    keywords: ['privacy', 'diagnostics', 'trace', 'logs', 'open', 'folder']
  },
  {
    title: 'Clear local traces',
    description: 'Delete every rotated trace file on this machine.',
    keywords: ['privacy', 'diagnostics', 'trace', 'clear', 'delete', 'reset']
  },
  {
    title: 'Share a diagnostic bundle',
    description:
      'Send the last 30 minutes of redacted traces to Orca support, after previewing what is sent.',
    keywords: ['privacy', 'diagnostics', 'bundle', 'share', 'support']
  },
  {
    title: 'OTLP export',
    description: 'Optional export to a user-run OpenTelemetry collector via ORCA_OTLP_TRACES_URL.',
    keywords: ['privacy', 'diagnostics', 'otlp', 'opentelemetry', 'grafana', 'lgtm']
  }
]

type PreviewState =
  | { stage: 'idle' }
  | { stage: 'collecting' }
  | { stage: 'preview'; bundle: DiagnosticsBundlePayload; editedPayload: string }
  | { stage: 'uploading'; bundle: DiagnosticsBundlePayload; editedPayload: string }
  | { stage: 'sent'; ticketId: string; bundleSubmissionId: string }

export function PrivacyPane(): React.JSX.Element {
  const [status, setStatus] = useState<DiagnosticsStatusPayload | null>(null)
  const [preview, setPreview] = useState<PreviewState>({ stage: 'idle' })
  const [copied, setCopied] = useState(false)
  // Why: the user can change env vars (DO_NOT_TRACK, ORCA_OTLP_TRACES_URL)
  // and we want the pane to refresh whenever the user re-opens Settings, so
  // we re-fetch status on mount rather than trusting a long-lived cache.
  const refreshTokenRef = useRef(0)
  // Why: the "Copied" indicator auto-resets after 2s. We track the timer so
  // rapid re-clicks cancel the previous reset (no racing timers flipping the
  // state back early) and so unmount tears the timer down (no setState on an
  // unmounted component).
  const copyTimerRef = useRef<number | null>(null)

  const refreshStatus = useCallback(async (): Promise<void> => {
    const token = ++refreshTokenRef.current
    try {
      const next = await window.api.diagnostics.getStatus()
      if (token === refreshTokenRef.current) {
        setStatus(next)
      }
    } catch {
      /* swallow — pane shows N/A while the IPC is unavailable */
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  // Why: tear down the "Copied" reset timer if the pane unmounts mid-window
  // (e.g., user closes Settings within 2s of clicking Copy). Without this,
  // the timer would fire setCopied on an unmounted component.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  const handleOpenFolder = useCallback(async (): Promise<void> => {
    try {
      await window.api.diagnostics.openTraceFolder()
    } catch {
      toast.error('Could not open trace folder')
    }
  }, [])

  const handleClear = useCallback(async (): Promise<void> => {
    try {
      await window.api.diagnostics.clearTraces()
      await refreshStatus()
      toast.success('Local trace files cleared')
    } catch {
      toast.error('Could not clear trace files')
    }
  }, [refreshStatus])

  const handleStartShare = useCallback(async (): Promise<void> => {
    setPreview({ stage: 'collecting' })
    try {
      const bundle = await window.api.diagnostics.collectBundle()
      setPreview({ stage: 'preview', bundle, editedPayload: bundle.payload })
    } catch (err) {
      setPreview({ stage: 'idle' })
      toast.error(`Could not collect bundle: ${(err as Error).message}`)
    }
  }, [])

  const handleConfirmUpload = useCallback(async (): Promise<void> => {
    if (preview.stage !== 'preview') {
      return
    }
    const { bundle, editedPayload } = preview
    setPreview({ stage: 'uploading', bundle, editedPayload })
    try {
      const result: DiagnosticsUploadPayload = await window.api.diagnostics.uploadBundle(
        editedPayload,
        bundle.bundleSubmissionId
      )
      setPreview({
        stage: 'sent',
        ticketId: result.ticketId,
        bundleSubmissionId: bundle.bundleSubmissionId
      })
    } catch (err) {
      // Stay on the preview screen so the user does not lose their edits;
      // the toast carries the failure detail and Cancel is still available.
      setPreview({ stage: 'preview', bundle, editedPayload })
      toast.error(`Could not upload bundle: ${(err as Error).message}`)
    }
  }, [preview])

  const handleCopyTicket = useCallback(async (): Promise<void> => {
    if (preview.stage !== 'sent') {
      return
    }
    try {
      await navigator.clipboard.writeText(preview.ticketId)
      setCopied(true)
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null
        setCopied(false)
      }, 2_000)
    } catch {
      toast.error('Could not copy ticket ID')
    }
  }, [preview])

  return (
    <div className="space-y-4">
      {status?.disabledReason ? <DisabledStateNote reason={status.disabledReason} /> : null}

      <Section
        icon={<Folder className="size-4" />}
        title="Open trace folder"
        description={`Reveals ${formatTracePath(status)} in your file manager. Inspect what Orca has captured locally before sharing anything.`}
      >
        <Button variant="outline" size="sm" onClick={() => void handleOpenFolder()}>
          Open trace folder
        </Button>
      </Section>

      <Separator />

      <Section
        icon={<Trash2 className="size-4" />}
        title="Clear local traces"
        description="Deletes every rotated trace file on this machine. Useful before handing a laptop to someone else."
      >
        <Button
          variant="outline"
          size="sm"
          disabled={!status?.localFileEnabled}
          onClick={() => void handleClear()}
        >
          Clear local traces
        </Button>
      </Section>

      <Separator />

      <Section
        icon={<FileText className="size-4" />}
        title="Share a diagnostic bundle"
        description="Send the last 30 minutes of redacted traces to Orca support. You will see exactly what is sent and can edit or cancel before upload. Bundles never carry your install ID — every submission gets a fresh anonymous ID."
      >
        <Button
          variant="outline"
          size="sm"
          disabled={!status?.bundleEnabled || preview.stage !== 'idle'}
          onClick={() => void handleStartShare()}
        >
          {preview.stage === 'collecting' ? 'Collecting…' : 'Share a diagnostic bundle'}
        </Button>
      </Section>

      {preview.stage === 'preview' || preview.stage === 'uploading' ? (
        <BundlePreview
          state={preview}
          onChange={(text) =>
            preview.stage === 'preview'
              ? setPreview({ ...preview, editedPayload: text })
              : undefined
          }
          onCancel={() => setPreview({ stage: 'idle' })}
          onConfirm={() => void handleConfirmUpload()}
        />
      ) : null}

      {preview.stage === 'sent' ? (
        <TicketReceipt
          ticketId={preview.ticketId}
          copied={copied}
          onCopy={() => void handleCopyTicket()}
          onDismiss={() => setPreview({ stage: 'idle' })}
        />
      ) : null}

      <Separator />

      <Section
        icon={<Globe className="size-4" />}
        title="OTLP export"
        description={
          status?.otlpStatus ??
          'Set ORCA_OTLP_TRACES_URL to point Orca at your own OpenTelemetry collector.'
        }
      >
        <span
          className={
            status?.otlpEnabled
              ? 'text-xs text-green-600 dark:text-green-400'
              : 'text-xs text-muted-foreground'
          }
        >
          {status?.otlpEnabled ? 'Enabled' : 'Disabled'}
        </span>
      </Section>
    </div>
  )
}

// ── helpers ──────────────────────────────────────────────────────────────

function formatTracePath(status: DiagnosticsStatusPayload | null): string {
  if (!status?.traceFilePath) {
    return 'the trace folder'
  }
  return status.traceFilePath
}

type SectionProps = {
  icon: React.ReactNode
  title: string
  description: string
  children: React.ReactNode
}

function Section({ icon, title, description, children }: SectionProps): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="flex flex-1 items-start gap-3">
        <div className="mt-1 text-muted-foreground">{icon}</div>
        <div className="space-y-1">
          <Label className="text-sm">{title}</Label>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="shrink-0 self-center">{children}</div>
    </div>
  )
}

type DisabledStateNoteProps = {
  reason: NonNullable<DiagnosticsStatusPayload['disabledReason']>
}

function DisabledStateNote({ reason }: DisabledStateNoteProps): React.JSX.Element {
  // Match the wording style of the existing telemetry Privacy pane:
  // identify the env var, no editorializing, leave the toggle disabled
  // since the user has signaled intent at the OS level.
  const message = (() => {
    switch (reason) {
      case 'do_not_track':
        return 'DO_NOT_TRACK=1 is set — network-bound diagnostics are disabled. The local trace file is still active.'
      case 'orca_telemetry_disabled':
        return 'ORCA_TELEMETRY_DISABLED=1 is set — network-bound diagnostics are disabled. The local trace file is still active.'
      case 'orca_diagnostics_disabled':
        return 'ORCA_DIAGNOSTICS_DISABLED=1 is set — every diagnostics surface is off, including local trace writes.'
      case 'ci':
        return 'Running in CI — diagnostics are off.'
      default:
        return 'Diagnostics are disabled by an environment variable.'
    }
  })()
  return (
    <div className="rounded border border-dashed border-border/60 bg-card/30 px-3 py-2 text-xs text-muted-foreground">
      {message}
    </div>
  )
}

type BundlePreviewProps = {
  state: Extract<PreviewState, { stage: 'preview' | 'uploading' }>
  onChange: (text: string) => void
  onCancel: () => void
  onConfirm: () => void
}

function BundlePreview({
  state,
  onChange,
  onCancel,
  onConfirm
}: BundlePreviewProps): React.JSX.Element {
  const uploading = state.stage === 'uploading'
  return (
    <div className="rounded border border-border/60 bg-card/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <Label htmlFor="diagnostics-bundle-preview" className="text-xs">
          Bundle preview · {state.bundle.spanCount} span(s) ·{' '}
          {Math.round(state.bundle.bytes / 1024)} KB
        </Label>
        <span className="text-xs text-muted-foreground">ID: {state.bundle.bundleSubmissionId}</span>
      </div>
      <textarea
        id="diagnostics-bundle-preview"
        className="h-72 w-full resize-y rounded border border-border/60 bg-background p-2 font-mono text-[11px] leading-tight"
        value={state.editedPayload}
        readOnly={uploading}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={uploading}>
          Cancel
        </Button>
        <Button size="sm" onClick={onConfirm} disabled={uploading}>
          {uploading ? 'Uploading…' : 'Send to Orca support'}
        </Button>
      </div>
    </div>
  )
}

type TicketReceiptProps = {
  ticketId: string
  copied: boolean
  onCopy: () => void
  onDismiss: () => void
}

function TicketReceipt({
  ticketId,
  copied,
  onCopy,
  onDismiss
}: TicketReceiptProps): React.JSX.Element {
  return (
    <div className="rounded border border-green-600/30 bg-green-500/5 p-3">
      <div className="text-sm font-medium">Bundle uploaded</div>
      <p className="mt-1 text-xs text-muted-foreground">
        Attach this ticket ID to your GitHub issue or support email so the Orca team can find your
        bundle. The ticket ID is the entire authentication mechanism — keep it private if you
        consider the bundle contents sensitive.
      </p>
      <div className="mt-2 flex items-center gap-2 rounded bg-background p-2 font-mono text-xs">
        <span className="flex-1 break-all">{ticketId}</span>
        <Button variant="ghost" size="sm" onClick={onCopy} className="gap-1">
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div className="mt-2 flex justify-end">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  )
}
