/**
 * The MCP tool registry (extracted from backend/workers/meta-mcp/index.js).
 *
 * Every tool carries a JSON Schema and MCP annotations (`title`, `readOnlyHint`,
 * `destructiveHint`, `openWorldHint`) - the title is what the Claude / ChatGPT
 * connector directories display.
 *
 * TOOLS holds the full set (33). The public JSON-RPC surface sees PUBLIC_TOOLS
 * only: every `plan_*` / `apply_*` tool is filtered out, so an external model can
 * read an ad account but can never prepare or apply a change through this server.
 * The plan tools are reached by Liaison's own agent runner and its UI, which put a
 * human confirm between the plan and the apply. `apply_write_plan` is not in
 * TOOLS at all: it is a fixed front-end route (see server.js, BW_FRONT).
 */
export const TOOLS = [
  {
    name: "plan_update_entity",
    description: "Prepare (but do NOT apply) a change to a live Meta campaign, ad set or ad. Covers status (pause), budgets (a daily amount, or a lifetime total with an end date), name, the end date itself, and on an AD SET the whole audience: age, gender, detailed targeting interests, languages, and locations including radius, regions, postcodes, dropped pins and exclusions - and its placements: platforms and positions or Advantage+, devices, mobile OS, Wi-Fi only, and limited spending on excluded placements. Returns a diff the user must confirm in the Build UI before anything is sent to Meta. Use when the user asks to pause something, change a budget, rename an entity, or change who or where an ad set targets. Budgets are in the ad account\'s own currency (multi-currency: EUR, USD, PLN, JPY\u2026). Audience fields are AD SET only and each REPLACES what is there, so send the whole list rather than only the thing that changed.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "Campaign, ad set, or ad ID" },
        entity_type: { type: "string", enum: ["campaign", "ad_set", "ad"], description: "What kind of entity this is" },
        status: { type: "string", enum: ["PAUSED"], description: "PAUSED only, to stop delivery. To turn something ON use plan_activate_entity instead: activation starts spending and gets its own checks and its own confirm." },
        daily_budget: { type: "number", description: "New daily budget in the AD ACCOUNT'S currency (e.g. 20 = 20 EUR/USD/PLN depending on the account; not minor units)" },
        name: { type: "string", description: "New name" },
        lifetime_budget: { type: "number", description: "AD SET only. TOTAL budget for the whole run, in the ad account's currency (not minor units). Meta requires an end date alongside it, so send end_time too. Replaces the daily budget." },
        end_time: { type: "string", description: "AD SET only. When the run stops, e.g. 2026-09-30T23:59:00+02:00. Required with lifetime_budget. Send \"0\" to REMOVE an existing end date; that is refused on an ad set carrying a lifetime budget. Never invent a date - ask." },
        special_ad_categories: { type: "array", items: { type: "string", enum: ["HOUSING", "EMPLOYMENT", "CREDIT", "FINANCIAL_PRODUCTS_SERVICES", "ONLINE_GAMBLING_AND_GAMING"] },
          description: "CAMPAIGN only. Declare the special ad category, or pass an empty array to remove it. Meta rewrites the audience of every ad set underneath: age becomes 18 to 65+, gender is dropped, part of the detailed targeting is removed. Meta may refuse the change on a campaign that already exists; its own answer is shown." },
        special_ad_category_country: { type: "array", items: { type: "string" },
          description: "CAMPAIGN only, two letter country codes. Required by Meta alongside a non-empty category. Liaison keeps the campaign's existing countries when this is not passed." },
        age_min: { type: "number", description: "AD SET only. Minimum age, 13 to 65. Leave it out to keep the current one." },
        age_max: { type: "number", description: "AD SET only. Maximum age, 13 to 65; 65 means 65+. Leave it out to keep the current one." },
        genders: { type: "string", enum: ["all", "men", "women"], description: "AD SET only. \"all\" removes the field, which is how Meta stores \"all genders\"." },
        interests: { type: "array", items: { type: "string" },
          description: "AD SET only. Detailed targeting BY NAME, the whole list - it replaces what is there. An empty array clears it. A name Meta does not know is refused rather than dropped." },
        locales: { type: "array", items: { type: "number" },
          description: "AD SET only. Meta locale ids, the whole list. An empty array means all languages." },
        age_range: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2,
          description: "AD SET with Advantage+ audience ON only. [min, max] - the SUGGESTED range Meta works from and may go beyond. Separate from age_min, which is the floor it will not cross. Refused on an ad set with Advantage+ off." },
        advantage_audience: { type: "string", enum: ["1", "0"], description: "AD SET only. Advantage+ audience on (1) or off (0). Off: the suggested range becomes the hard age. On: the age becomes the suggestion, the floor at most 25, no maximum." },
        geo: { type: "object",
          description: "AD SET only. REPLACES the whole location set, so send every place that should remain, not just the new one. Radii are kilometres and Meta sells TWO ranges: a city takes 17 to 80, a dropped pin takes 1 to 80. A place cannot be sent alongside something that CONTAINS it (a country and a city inside it); the wider one is dropped and the card says so. Limits: 250 cities, 200 regions, 50,000 postcodes. Omit it to leave locations alone.",
          properties: {
            countries: { type: "array", items: { type: "string" }, description: "Two letter codes." },
            cities: { type: "array", description: "Keys come from geo_search.",
              items: { type: "object", properties: { key: { type: "string" }, radius_km: { type: "number", description: "17 to 80. Below 17 is raised to 17 - Meta does not sell a smaller ring around a city." } }, required: ["key"] } },
            regions: { type: "array", description: "Keys from geo_search, type region. No radius: a region is its own boundary.",
              items: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
            zips: { type: "array", description: "Postcodes. Keys from geo_search, type zip, e.g. IT:20141.",
              items: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
            custom_locations: { type: "array", description: "Dropped pins. A pin has coordinates and a radius and no key of its own.",
              items: { type: "object", properties: { latitude: { type: "number" }, longitude: { type: "number" }, radius_km: { type: "number" }, address_string: { type: "string" } }, required: ["latitude", "longitude"] } },
            excluded: { type: "object", description: "Places to exclude, same countries, cities, regions and zips shape. Meta keeps these in a separate field, so the same city can be in both lists. Omit to leave the exclusions alone; send an empty object to clear them.",
              properties: { countries: { type: "array", items: { type: "string" } },
                cities: { type: "array", items: { type: "object", properties: { key: { type: "string" }, radius_km: { type: "number", description: "17 to 80. Below 17 is raised to 17 - Meta does not sell a smaller ring around a city." } }, required: ["key"] } },
                regions: { type: "array", items: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
                zips: { type: "array", items: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } } } }
          } },
        placements: { description: "AD SET only. \"auto\" for Advantage+ placements, or { publisher_platforms, facebook_positions, instagram_positions, threads_positions, messenger_positions, audience_network_positions, whatsapp_positions } - the WHOLE set, it replaces. A platform with no positions list runs on all of its positions. Instagram explore and Facebook video_feeds are refused by Meta on v26.0; use explore_home." },
        device_platforms: { type: "array", items: { type: "string", enum: ["mobile", "desktop"] }, description: "AD SET only. Devices to run on; both is all devices." },
        user_os: { type: "string", enum: ["all", "android", "ios"], description: "AD SET only. Mobile operating system. Needs mobile among the devices." },
        wifi_only: { type: "boolean", description: "AD SET only. Deliver to mobile only when connected to Wi-Fi." },
        placement_soft_opt_out: { type: "object", description: "AD SET only. Allow limited spending (about 5% each) on EXCLUDED placements: { <platform>_positions: [...] }, each position excluded by the ad set or by the ad account. {} turns it off." }
      },
      required: ["entity_id", "entity_type"]
    },
    annotations: { title: "Plan an Ad Change", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "plan_activate_entity",
    description: "Prepare (but do NOT apply) the ACTIVATION of a paused campaign, ad set, or ad — this is what starts spending money, so it always gets its own confirmation in the Build UI. Also checks parent statuses and warns if the parent chain is paused. Use when the user asks to activate, publish, or turn on something that is PAUSED. To PAUSE something, use plan_update_entity instead.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "Campaign, ad set, or ad ID" },
        entity_type: { type: "string", enum: ["campaign", "ad_set", "ad"] }
      },
      required: ["entity_id", "entity_type"]
    },
    annotations: { title: "Plan an Activation", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "plan_copy_entity",
    description: "Prepare (but do NOT apply) a duplicate of a campaign, ad set, or ad. Ad sets and campaigns are deep-copied with their subtree. The copy is always created PAUSED \u2014 it spends nothing until the user activates it. Use when the user asks to duplicate, clone, or copy something. To copy an AD into a DIFFERENT ad set, pass destination_id with that ad set's id. Without destination_id the copy lands beside the original.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "ID of the entity to duplicate" },
        entity_type: { type: "string", enum: ["campaign", "ad_set", "ad"] },
        rename_suffix: { type: "string", description: "Optional. Suffix added to every ad set and ad INSIDE the copy, e.g. ' v2'. Leave it out and the children keep their original names." },
        destination_id: { type: "string", description: "Optional. Where the copy goes: an AD SET id when copying an ad, a CAMPAIGN id when copying an ad set. Omit to copy beside the original." }
      },
      required: ["entity_id", "entity_type"]
    },
    annotations: { title: "Plan a Duplicate", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "plan_create_ad_from_creative",
    description: "Prepare (but do NOT apply) a NEW ad inside an existing ad set using an EXISTING creative from the account's library (e.g. the best-performing creative from analytics). The ad is created PAUSED. Use when the user asks to put a creative into an ad set, launch the best creative somewhere, or build an ad from an existing creative. Get creative IDs from get_creative_analysis or get_creatives.",
    inputSchema: {
      type: "object",
      properties: {
        ad_set_id: { type: "string", description: "Target ad set ID" },
        creative_id: { type: "string", description: "Existing creative ID from the account library. Give this OR source_ad_id, not both." },
        source_ad_id: { type: "string", description: "Alternative to creative_id: an existing AD id. Liaison reads that ad's own creative and uses it. Prefer this when the user gives you an ad id." },
        name: { type: "string", description: "Optional ad name" }
      },
      required: ["ad_set_id"]
    },
    annotations: { title: "Plan an Ad from a Creative", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "list_ad_accounts",
    description: "List all Meta Ads accounts connected to the user. Returns account IDs, names, and identifiers. Call this first to get the account ID needed for other tools.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    annotations: { title: "List Ad Accounts", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_account_stats",
    description: "Get key performance metrics for a Meta Ads account over a date range. Returns spend, impressions, clicks, leads, CTR, CPL, and per-ad breakdown with spend per creative.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" },
        from: { type: "string", description: "Start date in YYYY-MM-DD format" },
        to: { type: "string", description: "End date in YYYY-MM-DD format" }
      },
      required: ["from", "to"]
    },
    annotations: { title: "Get Account Stats", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_campaigns",
    description: "List all campaigns in a Meta Ads account with performance metrics for a date range. Returns campaign name, status, objective, spend, clicks, leads for each campaign.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" }
      },
      required: ["account", "from", "to"]
    },
    annotations: { title: "List Campaigns", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_adsets",
    description: "List all ad sets in a specific campaign with performance metrics. Returns ad set name, status, optimization goal, spend, clicks, leads.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" },
        campaign: { type: "string", description: "Campaign ID" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" }
      },
      required: ["account", "campaign", "from", "to"]
    },
    annotations: { title: "List Ad Sets in Campaign", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
      name: "get_budget",
      description: "Read the CURRENT budget of a campaign or ad set, live from Meta with no date window. Use this whenever the user asks what a budget IS (as opposed to changing it) — it works even when the object is paused, which get_ads_tree does not. Returns where the budget lives: a campaign budget (CBO), the campaign's ad-set budgets (ABO), or none.",
      inputSchema: {
        type: "object",
        properties: {
          entity_id: { type: "string", description: "id (digits) from find_entity" },
          entity_type: { type: "string", enum: ["campaign", "ad_set"], description: "campaign or ad_set" }
        },
        required: ["entity_id"]
      }
    },
    {
    name: "find_entity",
    description: "RESOLVE a campaign, ad set, or ad by NAME or ID before doing anything with it. Reads the account's full structure with NO date window, so it also finds things that spent nothing recently — get_ads_tree CANNOT see those. Names are NOT unique: the same ad name can exist in many ad sets and campaigns, so ALWAYS resolve here first and NEVER guess an ID from a tree or from memory. Returns every match with its full path (campaign → ad set → ad) and status. Leave query EMPTY (with an optional kind and/or status) to LIST everything — e.g. kind:campaign status:PAUSED lists every paused campaign, which get_ads_tree can never show. If more than one matches a name, ASK the user which one — do not pick.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name (or part of it) or an exact ID" },
        kind: { type: "string", enum: ["campaign", "ad_set", "ad"], description: "Optional: only return matches of this kind" },
        status: { type: "string", enum: ["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"], description: "Optional: only matches with this status. Use status PAUSED with an empty query to LIST everything that is not running." },
        account: { type: "string", description: "Ad account ID (without act_ prefix)" }
      },
      required: []
    },
    annotations: { title: "Find a Campaign, Ad Set or Ad", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_ads_tree",
    description: "Get the campaign structure WITH SPEND for a date window: Campaign → Ad Set → Ad. Use it for analysis and money questions. WARNING: it is built from insights, so anything that did not spend inside the window is MISSING from it — never resolve an entity for a change from this tree, and never assume something does not exist because it is absent here. To resolve a campaign/ad set/ad by name or id, use find_entity.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" }
      },
      required: ["from", "to"]
    },
    annotations: { title: "Get Full Ads Tree", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_leads",
    description: "Get leads with phone numbers, ad attribution, and dates. Each lead includes: phone number, ad_id, ad_name, adset_id, campaign_id, account_id, and creation date. Leads are stored permanently — even after Meta deletes them (90-day retention). This data is NOT available through Meta's official MCP.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID to filter by (optional — omit for all accounts)" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" }
      },
      required: ["from", "to"]
    },
    annotations: { title: "Get Leads", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_lead_forms",
    description: "List all lead generation forms on the connected Facebook Page. Returns form IDs, names, and configuration.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    annotations: { title: "List Lead Forms", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_creatives",
    description: "Get creative preview images/videos for specific ads. Returns ad preview URL (image or video thumbnail), creative name, and type. Previews are cached for fast retrieval.",
    inputSchema: {
      type: "object",
      properties: {
        ad_ids: {
          type: "string",
          description: "Comma-separated list of ad IDs to get previews for"
        }
      },
      required: ["ad_ids"]
    },
    annotations: { title: "Get Ad Creatives (Previews)", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_home_dashboard",
    description: "Get a home dashboard summary: total spend, leads count, and cost per lead (CPL) for a date range. Quick overview of Meta Ads performance.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" }
      },
      required: ["from", "to"]
    },
    annotations: { title: "Get Home Dashboard", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "compare_periods",
    description: "Compare Meta Ads performance between two date ranges. Returns current period KPI, previous period KPI, and percentage delta for each metric (spend, clicks, leads, CTR, CPL). Useful for week-over-week or month-over-month comparisons.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID" },
        range: {
          type: "string",
          enum: ["last_7_days", "last_30_days", "custom"],
          description: "Predefined range or 'custom' for manual dates"
        },
        from: { type: "string", description: "Start date YYYY-MM-DD (for custom range)" },
        to: { type: "string", description: "End date YYYY-MM-DD (for custom range)" }
      },
      required: []
    },
    annotations: { title: "Compare Two Periods", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "export_leads",
    description: "Export leads as a downloadable CSV or XLS file. Returns a download URL for the exported file containing all leads with phone numbers, ad attribution, and dates.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (optional)" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" },
        format: {
          type: "string",
          enum: ["csv", "xls"],
          description: "Export format (default: csv)"
        },
        platform: { type: "string", enum: ["fb", "ig"], description: "Only Facebook or only Instagram leads (optional)" }
      },
      required: ["from", "to"]
    },
    annotations: { title: "Export Leads to CSV/XLS", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_demographics",
    description: "Get audience demographics breakdown for a Meta Ads account: age groups (18-24, 25-34, etc.), gender (male/female), and geographic regions. Shows spend, impressions, clicks, and leads for each segment. Useful for understanding who your ads reach and which demographics convert best.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" }
      },
      required: ["from", "to"]
    },
    annotations: { title: "Get Account Demographics", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_time_patterns",
    description: "Analyze when leads come in: breakdown by day of week (Mon-Sun), hour of day (0-23), and daily trend. Identifies the best day and best hour for lead generation. Based on stored lead data — zero Meta API calls, instant response. Great for optimizing ad scheduling. Can filter by specific ad, campaign, adset, or account.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" },
        ad_id: { type: "string", description: "Filter by specific ad ID (optional)" },
        campaign_id: { type: "string", description: "Filter by campaign ID (optional)" },
        adset_id: { type: "string", description: "Filter by ad set ID (optional)" },
        account_id: { type: "string", description: "Filter by ad account ID (optional)" }
      },
      required: ["from", "to"]
    },
    annotations: { title: "Get Lead Time Patterns", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_lead_quality",
    description: "Analyze lead quality: duplicate phone numbers, invalid/fake numbers, platform split (Instagram vs Facebook), account split, and campaign split. Based on stored lead data — zero Meta API calls, instant response. Essential for identifying wasted ad spend on low-quality leads. Can filter by specific ad, campaign, adset, or account.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" },
        ad_id: { type: "string", description: "Filter by specific ad ID (optional)" },
        campaign_id: { type: "string", description: "Filter by campaign ID (optional)" },
        adset_id: { type: "string", description: "Filter by ad set ID (optional)" },
        account_id: { type: "string", description: "Filter by ad account ID (optional)" }
      },
      required: ["from", "to"]
    },
    annotations: { title: "Analyze Lead Quality", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_creative_analysis",
    description: "Rank ad creatives by performance: each ad with spend, leads, CPL, CTR, and creative preview URL. Sorted by cost-per-lead (best first). Identifies best and worst performing creatives. Limited to top 15 ads by spend. Combines Meta Insights API with cached creative previews. Also saves insights snapshot and persists preview images permanently.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" }
      },
      required: ["from", "to"]
    },
    annotations: { title: "Rank Creatives by Performance", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_insights_history",
    description: "Retrieve historical insights or demographics snapshots from permanent storage. Shows spend, leads, CPL, and per-ad breakdown for past periods — even if Meta no longer returns that data. Snapshots are automatically created when get_creative_analysis or get_demographics are called. Use type 'insights' for ad performance data, 'demographics' for age/gender/region data.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" },
        type: {
          type: "string",
          enum: ["insights", "demographics"],
          description: "Type of historical data: 'insights' for spend/leads/CPL, 'demographics' for age/gender/region (default: insights)"
        }
      },
      required: ["account"]
    },
    annotations: { title: "Get Historical Insights", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_ad_demographics",
    description: "Get audience demographics breakdown PER INDIVIDUAL AD: age groups (18-24, 25-34, etc.), gender (male/female), and geographic regions for each ad separately. Shows spend, impressions, clicks, and leads for each demographic segment per ad. Essential for understanding which creatives resonate with which audience segments.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" }
      },
      required: ["from", "to"]
    },
    annotations: { title: "Get Per-Ad Demographics", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_ads_status",
    description: "Get current status of all ads in an account: effective_status (ACTIVE/PAUSED/ARCHIVED/DELETED), created_time, updated_time. Optionally includes daily activity data showing which days each ad was active (had spend/impressions). Saves daily snapshots to build status history over time. Use from/to params to include activity data.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" },
        from: { type: "string", description: "Start date YYYY-MM-DD for activity data (optional)" },
        to: { type: "string", description: "End date YYYY-MM-DD for activity data (optional)" }
      },
      required: []
    },
    annotations: { title: "Get Ads Status", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_daily_breakdown",
    description: "Day-by-day performance, returned BOTH per campaign and per ad. Use this for any 'cost per X over time', 'compare campaigns', 'dynamics', 'trend' or 'chart by day' question. ALWAYS pass campaign_id when the user has named, chosen or implied specific campaigns - the chart draws exactly the campaigns this call returns, so omitting the filter puts campaigns on screen that the user never asked about and your answer will describe something different from what they see. Omit campaign_id ONLY for a genuine whole-account question. At most 3 campaigns are charted; if more are returned, only the 3 largest by spend are drawn, so narrow the filter yourself rather than relying on that. Each campaign in campaigns[] carries its own target_action (what a conversion MEANS for it - a lead form submit, a WhatsApp conversation started, a landing page view, a purchase) plus daily spend, action count and cost_per_action. Campaigns often optimise for DIFFERENT actions, so compare cost_per_action between them, never the raw counts. available_actions lists every action type that actually occurred; pass action_type to chart one of those instead of the automatic pick. ads[] additionally carries fatigue detection (CPL first half vs second half, flagged healthy/warning/fatiguing).",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" },
        ad_id: { type: "string", description: "Filter by specific ad ID (optional)" },
        campaign_id: { type: "string", description: "Campaign IDs to chart, comma-separated, numeric, up to 3 ids (a limit on how many CAMPAIGNS one chart draws, not on how many calls you may make). Pass it when the user named, picked or implied particular campaigns - the chart draws exactly the campaigns this call returns, and a choice made earlier in the conversation still stands. Omit for a whole-account view." },
        action_type: { type: "string", description: "Force the target action for every campaign, e.g. 'lead', 'onsite_conversion.messaging_conversation_started_7d', 'landing_page_view', 'purchase'. Omit to let each campaign use its own most meaningful action." }
      },
      required: ["from", "to"]
    },
    annotations: { title: "Get Daily Performance Breakdown", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_targeting_config",
    description: "Get targeting configuration for all ad sets: geographic locations (with coordinates resolved to district/suburb/city names like 'Old Town, City A' or 'Riverside, City A'), age range, gender, interests, and publisher platforms. Custom location pins show the exact neighborhood/district name + radius. Essential for understanding WHERE ads are shown and to WHOM.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" }
      },
      required: []
    },
    annotations: { title: "Get Ad-Set Targeting", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_platform_breakdown",
    description: "Get Instagram vs Facebook spend/CPL/leads breakdown per ad. Shows where budget goes vs where leads come from. Includes efficiency score: if an ad spends 80% on Instagram but gets 60% of leads from Facebook, Facebook has higher efficiency (0.75 ratio). Essential for platform optimization.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" }
      },
      required: ["from", "to"]
    },
    annotations: { title: "Get Instagram vs Facebook Breakdown", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_creative_text",
    description: "Get the actual ad creative content: title, body text, description, call-to-action type, link URL, image URL, and video ID for each ad. Essential for understanding WHY one creative performs better than another. Can filter by specific ad_id or return all ads.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" },
        ad_id: { type: "string", description: "Specific ad ID to get creative text for (optional — returns all if omitted)" }
      },
      required: []
    },
    annotations: { title: "Get Ad Creative Text (Title/Body/CTA)", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_adset_performance",
    description: "Get performance (spend, leads, CPL, CTR, reach, frequency) per ad set, combined with geo targeting data showing exact districts and neighborhoods. Since each ad set targets a specific location, this effectively shows CPL per district/area — e.g. 'District A: CPL 4.20' vs 'District B: CPL 7.80'. Sorted by CPL (best first).",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" }
      },
      required: ["from", "to"]
    },
    annotations: { title: "Get Ad-Set Performance", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "compare_creatives",
    description: "Cross-creative comparison: finds the BEST creative for each audience segment (age × gender). Shows which ad has the lowest CPL for men 25-34, which is best for women 55-64, etc. Also provides age_ranking — which age group converts cheapest overall and which creative wins in that age group. Essential for creative optimization and audience-creative matching.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" }
      },
      required: ["from", "to"]
    },
    annotations: { title: "Compare Creatives Across Segments", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_budget_utilization",
    description: "Budget analysis per campaign: daily budget cap vs actual average daily spend. Shows utilization percentage and status: 'maxed_out' (>95% — can't scale further without raising budget), 'healthy' (70-95%), 'underspending' (40-70% — audience may be exhausted), 'low' (<40%). Includes per-day spend trend and adset budget breakdown.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Ad account ID (without act_ prefix)" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" }
      },
      required: ["from", "to"]
    },
    annotations: { title: "Get Budget Utilization", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_my_ai_history",
    description: "Retrieve YOUR past Liaison AI sessions across ALL connected LLMs (Claude, ChatGPT, Gemini). Returns a summary of previous sessions: which tools you used, when, and on which LLM — so you can pick up where you left off and compare what you analysed before. Use this at the start of a conversation to recall prior context. Paid feature (Memory/Studio plans).",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD (optional, default 30 days ago)" },
        to: { type: "string", description: "End date YYYY-MM-DD (optional, default now)" },
        tool_filter: { type: "string", description: "Only sessions that used this tool (optional)" },
        limit: { type: "number", description: "Max sessions to return (default 10, max 50)" }
      },
      required: []
    },
    annotations: { title: "Get My AI Session History", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_ai_session_detail",
    description: "Retrieve the FULL log of one specific past Liaison AI session by its session_id (from get_my_ai_history): every tool call with its parameters and full response. Use when you need the exact data from a previous session, not just the summary. Paid feature (Memory/Studio plans).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The session_id to retrieve (from get_my_ai_history)" }
      },
      required: ["session_id"]
    },
    annotations: { title: "Get AI Session Detail", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }
];

// The public MCP surface: analytics only. Write tools are enforced out in code,
// not by prompting the client model.
export const PUBLIC_TOOLS = TOOLS.filter(t => !/^(plan_|apply_)/.test(t.name));
