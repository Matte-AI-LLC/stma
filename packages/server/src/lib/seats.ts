import { ne } from 'drizzle-orm';
import { memberships } from '../db/schema';

/** Headless service principals are never human seats. Agent/device count is unrelated. */
export const humanMembership = () => ne(memberships.role, 'service');
