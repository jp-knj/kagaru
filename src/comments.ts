import type { Snapshot } from './ast.js';

export function importCommentRange(
	{ source, comments }: Snapshot,
	min: number,
	max: number,
): [number, number] {
	const leading = comments.filter((comment) => comment.start >= min && comment.end <= max);
	const documentation = leading.findLast(
		(comment) =>
			comment.type === 'Block' &&
			comment.value.startsWith('*') &&
			(min === 0 || /[\r\n\u2028\u2029]/.test(source.slice(min, comment.start))),
	);
	const statementStart =
		leading.find((comment) => {
			if (comment === documentation) return true;
			const lastLine = source
				.slice(comment.start, comment.end)
				.split(/\r\n|[\r\n\u2028\u2029]/)
				.at(-1)!
				.trimStart();
			return (
				comment.type === 'Line'
					? /^\/\/\/?\s*@(ts-expect-error|ts-ignore)/
					: /^(?:\/|\*)*\s*@(ts-expect-error|ts-ignore)/
			).test(lastLine);
		})?.start ?? max;
	const headerEnd =
		min === 0
			? (leading.findLast(
					(comment) =>
						comment.type === 'Line' &&
						(/^\/?\s*@ts-(check|nocheck)\b/.test(comment.value) ||
							/^\/\s*<(reference|amd-module|amd-dependency)\b/.test(comment.value)),
				)?.end ?? min)
			: min;
	return [headerEnd, statementStart];
}
