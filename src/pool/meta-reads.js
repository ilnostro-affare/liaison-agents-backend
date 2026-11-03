/**
 * Placeholders for the Graph read layer of the original worker (account list, ads
 * tree with insights, ad-set targeting, creative previews). Not part of this
 * extract: they are ~thousands of lines of Meta-specific reading and caching.
 * Each resolves to the shape build.js consumes:
 *   coreAccounts(env, member)                 -> { accounts: [{ id, name }] }
 *   coreTree(env, member, acct, from, to)     -> { tree: { [campaignId]: { adsets: { [id]: { id, ads: [{ ad_id, status, effective_status, spend, leads, impressions, ctr, cpl }] } } } } }
 *   coreTargeting(env, member, acct, opts)    -> { adsets: [{ adset_id, targeting: { geo: { custom_locations: [{ latitude, longitude, radius }] } } }] }
 *   coreCreatives(env, member, adIds)         -> { creatives: { [adId]: { preview, preview_hi, video_id } } }
 */
const missing = (name) => async () => { throw new Error(name + " is not included in this extract"); };
export const coreAccounts = missing("coreAccounts");
export const coreTree = missing("coreTree");
export const coreTargeting = missing("coreTargeting");
export const coreCreatives = missing("coreCreatives");
