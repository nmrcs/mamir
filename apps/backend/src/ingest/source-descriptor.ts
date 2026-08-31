import { z } from 'zod'

// A description of the SOURCE, not of the domain.
//
// "Two files, `|` delimiter, no headers, join by key" is a property of how
// the dataset is published, not of how the risk works. So it is not part of
// DomainPlugin: the core never reads the descriptor and knows nothing of
// it; only the loader reads it. The plugin stays a domain description.
const FileSpec = z.object({
	file: z.string().min(1),
	// Needed when the file has no header row: columns are recognized by
	// position. With header: true they are not set.
	columns: z.array(z.string().min(1)).min(1).optional(),
})

export const SourceDescriptor = z
	.object({
		delimiter: z.string().length(1).default(','),
		header: z.boolean().default(true),
		main: FileSpec,
		// A lookup file glued onto every row of the main file: in SFLLD loan
		// characteristics live apart from the monthly history.
		join: FileSpec.extend({ on: z.string().min(1) }).optional(),
	})
	.refine((s) => s.header || s.main.columns !== undefined, {
		message: 'header: false requires a column list',
		path: ['main', 'columns'],
	})
	.refine((s) => s.header || !s.join || s.join.columns !== undefined, {
		message: 'header: false requires a column list for the join file too',
		path: ['join', 'columns'],
	})
export type SourceDescriptor = z.infer<typeof SourceDescriptor>
