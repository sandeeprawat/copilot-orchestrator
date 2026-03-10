// Evaluator: uses copilot to assess task results and decide on refinement
import { executeTask } from './executor.js';
import config from './config.js';
import logger from './logger.js';

const COMPONENT = 'Evaluator';

export async function evaluateResult(task, result) {
  const taskId = task.id;

  // Skip evaluation if max refinements reached
  if (task.refinement_count >= task.max_refinements) {
    logger.info(COMPONENT, `Task ${taskId}: max refinements (${task.max_refinements}) reached, accepting result`, taskId);
    return { passed: true, score: null, reasoning: 'Max refinements reached', improvementPrompt: null };
  }

  // Build evaluation prompt
  const evalPrompt = config.evaluationPromptTemplate
    .replace('{{TASK_PROMPT}}', task.original_prompt || task.prompt)
    .replace('{{TASK_RESULT}}', (result || '').slice(0, 8000));

  logger.info(COMPONENT, `Evaluating task ${taskId} (refinement ${task.refinement_count}/${task.max_refinements})`, taskId);

  // Use copilot to evaluate
  const evalTask = {
    id: `eval-${taskId}`,
    prompt: evalPrompt,
    workdir: task.workdir || config.ROOT,
    timeout_ms: 120_000, // 2 min for evaluation
    copilot_args: '[]',
  };

  const evalResult = await executeTask(evalTask);

  if (!evalResult.success || !evalResult.result) {
    logger.warn(COMPONENT, `Evaluation failed for ${taskId}, accepting result by default`, taskId);
    return { passed: true, score: null, reasoning: 'Evaluation failed', improvementPrompt: null };
  }

  // Parse evaluation response
  try {
    const evaluation = extractJSON(evalResult.result);
    if (evaluation) {
      // Normalize fields
      evaluation.passed = evaluation.passed === true || evaluation.score >= 7;
      evaluation.gaps = evaluation.gaps || [];
      evaluation.improvementPrompt = evaluation.improvementPrompt || null;
      logger.info(COMPONENT, `Task ${taskId} score: ${evaluation.score}/10 — ${evaluation.passed ? 'PASSED' : 'NEEDS IMPROVEMENT'}`, taskId);
      if (!evaluation.passed && evaluation.gaps.length > 0) {
        logger.info(COMPONENT, `Gaps: ${evaluation.gaps.join('; ')}`, taskId);
      }
      return evaluation;
    }
  } catch (e) {
    logger.warn(COMPONENT, `Failed to parse evaluation for ${taskId}: ${e.message}`, taskId);
  }

  // Default: accept
  return { passed: true, score: null, reasoning: 'Could not parse evaluation', improvementPrompt: null };
}

function extractJSON(text) {
  // Try to find JSON in the response text — handle various formats
  // First try: find a JSON block with our expected fields
  const patterns = [
    /```json\s*([\s\S]*?)```/,
    /```\s*([\s\S]*?)```/,
    /(\{[\s\S]*?"score"[\s\S]*?"passed"[\s\S]*?\})/,
    /(\{[\s\S]*?"passed"[\s\S]*?"score"[\s\S]*?\})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      try {
        const parsed = JSON.parse(match[1] || match[0]);
        if ('score' in parsed || 'passed' in parsed) return parsed;
      } catch { /* try next pattern */ }
    }
  }

  // Last resort: try to parse the entire text as JSON
  try {
    const parsed = JSON.parse(text.trim());
    if ('score' in parsed || 'passed' in parsed) return parsed;
  } catch { /* not JSON */ }

  return null;
}
