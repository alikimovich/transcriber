// MCP server surface: lets an agent read the live transcript and ask for an
// interpretation, over stdio.
//
// Nothing may be written to stdout here — stdout is the JSON-RPC channel.
// Diagnostics go to stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { loadContext } from './config.ts'
import { interpret } from './interpret.ts'
import { loadSettings } from './settings.ts'
import type { TranscriptStore } from './transcript.ts'

export interface McpDeps {
  transcript: TranscriptStore
}

export function buildServer({ transcript }: McpDeps): McpServer {
  const server = new McpServer({ name: 'interview-lens', version: '0.1.0' })

  server.registerTool(
    'get_transcript',
    {
      title: 'Get interview transcript',
      description:
        'Return the recent interview transcript, labelled by speaker. ' +
        'The interviewer channel is captured from system audio; the candidate ' +
        'channel is the local microphone.',
      // Note: the current SDK takes a RAW Zod shape here, not z.object(...).
      inputSchema: {
        seconds: z
          .number()
          .optional()
          .describe('How far back to look. Defaults to the whole session.')
      },
      outputSchema: {
        turns: z.array(
          z.object({
            speaker: z.enum(['interviewer', 'candidate']),
            text: z.string(),
            start: z.number(),
            end: z.number(),
            isFinal: z.boolean()
          })
        )
      }
    },
    async ({ seconds }) => {
      const turns = transcript.window(seconds ?? Number.POSITIVE_INFINITY)
      const structuredContent = {
        turns: turns.map((t) => ({
          speaker: t.channel,
          text: t.text,
          start: t.startedAt,
          end: t.endedAt,
          isFinal: t.isFinal
        }))
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: turns.length
              ? turns.map((t) => `${t.channel}: ${t.text}`).join('\n')
              : '(no transcript yet)'
          }
        ],
        structuredContent
      }
    }
  )

  server.registerTool(
    'interpret_question',
    {
      title: "Interpret the interviewer's question",
      description:
        "Explain what the interviewer's most recent question is probing for, " +
        'using the recent conversation and the saved setup context. Returns an ' +
        'interpretation, not an answer.',
      inputSchema: {
        seconds: z
          .number()
          .optional()
          .describe('How much recent transcript to consider. Default 300.')
      },
      outputSchema: {
        intent: z.string(),
        emphasis: z.string(),
        clarification: z.string().nullable(),
        confidence: z.enum(['low', 'medium', 'high'])
      }
    },
    async ({ seconds }) => {
      const turns = transcript.window(seconds ?? 300)
      const settings = await loadSettings()
      const result = await interpret(
        { turns, context: await loadContext() },
        { savedProvider: settings.provider, model: settings.model ?? undefined }
      )

      if (result.kind !== 'ok') {
        // interpret() never throws; every failure mode is a `kind`. Report it
        // as a tool error rather than inventing an interpretation.
        const detail =
          result.kind === 'refusal'
            ? `the model declined: ${result.message}`
            : result.kind === 'incomplete'
              ? `response incomplete (${result.reason})`
              : result.kind === 'malformed'
                ? `model returned something that isn't an interpretation: ${result.message}`
                : result.message
        return {
          isError: true,
          content: [{ type: 'text' as const, text: detail }]
        }
      }

      const { intent, emphasis, clarification, confidence } = result.interpretation
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Likely testing: ${intent}`,
              `Emphasize: ${emphasis}`,
              clarification ? `Clarify: ${clarification}` : '',
              `Confidence: ${confidence}`
            ]
              .filter(Boolean)
              .join('\n')
          }
        ],
        structuredContent: result.interpretation
      }
    }
  )

  server.registerResource(
    'current-transcript',
    'transcript://current',
    {
      title: 'Current interview transcript',
      description: 'The full in-memory transcript for this session.',
      mimeType: 'application/json'
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(transcript.window(Number.POSITIVE_INFINITY), null, 2)
        }
      ]
    })
  )

  return server
}

export async function serveStdio(deps: McpDeps): Promise<void> {
  await buildServer(deps).connect(new StdioServerTransport())
}
