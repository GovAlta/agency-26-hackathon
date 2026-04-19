# Alberta Open Data - AI For Accountability

## Project Context

This is the Alberta Open Data pipeline for the **AI For Accountability Hackathon**. It contains four Alberta government datasets loaded into the `ab` schema of a shared PostgreSQL database.

The companion projects are `../CRA/` (CRA T3010 charity data in `cra` schema) and `../FED/` (Federal Grants and Contributions in `fed` schema).

## Database

- **Schema**: `ab` (search path set automatically by `lib/db.js`)
- **Connection**: `.env.public` (read-only) loaded first, `.env` (admin) overrides if present

### Tables

| Table | Description | Rows |
|-------|-------------|------|
| `ab.ab_grants` | Alberta grant payment records (2014-2025) | ~1M+ |
| `ab.ab_grants_fiscal_years` | Fiscal year aggregations | 11 |
| `ab.ab_grants_ministries` | Ministry aggregations by fiscal year | ~321 |
| `ab.ab_grants_programs` | Program aggregations by ministry/fiscal year | ~17K |
| `ab.ab_grants_recipients` | Recipient aggregations | ~420K |
| `ab.ab_contracts` | Blue Book contracts (supplies & services) | ~67K |
| `ab.ab_sole_source` | Sole-source contracts | ~15K |
| `ab.ab_non_profit` | Alberta Non-Profit Registry | ~69K |
| `ab.ab_non_profit_status_lookup` | Non-profit status definitions | 13 |

### Views

| View | Description |
|------|-------------|
| `ab.vw_grants_by_ministry` | Grant payments aggregated by ministry and fiscal year |
| `ab.vw_grants_by_recipient` | Grant payments aggregated by recipient |
| `ab.vw_non_profit_decoded` | Non-profit registry joined with status definitions |

## Key Fields

### Grants
- `mongo_id`: Unique identifier (from MongoDB source)
- `ministry`, `business_unit_name`: Government department
- `recipient`: Organization/individual receiving payment
- `program`: Grant program name
- `amount`: Payment amount (can be negative for reversals)
- `display_fiscal_year`: "YYYY - YYYY" format (e.g., "2024 - 2025")
- `payment_date`: Date of payment
- `lottery`: Whether funded by lottery ("True"/"False")

### Contracts (Blue Book)
- `display_fiscal_year`: Fiscal year range
- `recipient`: Vendor/contractor name
- `amount`: Contract value
- `ministry`: Alberta ministry

### Sole-Source
- `ministry`: Alberta ministry
- `vendor`: Contractor name
- `amount`: Contract value
- `start_date`, `end_date`: Contract period
- `contract_number`: Contract identifier
- `contract_services`: Description of services
- `permitted_situations`: Sole-source justification code
- Department/vendor address fields (street, city, province, postal code, country)

### Non-Profit Registry
- `type`: Legal entity type (e.g., "Agricultural Society", "Society")
- `legal_name`: Organization name
- `status`: Current status (active, dissolved, struck, etc.)
- `registration_date`: Date of registration
- `city`, `postal_code`: Location

## Pipeline Scripts

```bash
npm run migrate         # Create ab schema, tables, indexes, views
npm run seed            # Populate status definitions lookup
npm run import:grants   # Import grants JSON data (streaming, ~5-10 min)
npm run import:contracts    # Import Blue Book Excel
npm run import:sole-source  # Import sole-source Excel
npm run import:non-profit   # Import non-profit registry Excel
npm run import:all      # All four imports sequentially
npm run verify          # Comprehensive verification checks
npm run setup           # Full pipeline: migrate + seed + import:all + verify
npm run drop            # Destructive: drop all AB tables and schema
npm run reset           # Drop + setup
```

## Data Sources

All data is pre-downloaded (no API). Source files are in `data/`:
- `data/grants/test.opendata*.json` - Alberta Grants (from MongoDB export)
- `data/contracts/blue-book-master.xlsx` - Blue Book contracts
- `data/sole-source/solesource.xlsx` - Sole-source contracts
- `data/non-profit/non_profit_name_list_for_open_data_portal.xlsx` - Non-profit registry
- `data/non-profit/non-profit-listing-status-definitions.xlsx` - Status definitions

## Important Notes

- **Fiscal year format**: All datasets use "YYYY - YYYY" with spaces (e.g., "2024 - 2025")
- **Negative amounts** in grants are reversals/corrections, not errors
- **Non-profit dates** go back to 1979 (long-established organizations)
- **Sole-source `special` field** contains boolean-like values
- **Lottery-funded grants** are flagged with `lottery = 'True'`

## Testing

```bash
npm run test:unit       # 37 transformer tests (no DB required)
npm run test:integration  # Schema + row count + quality checks
npm run test            # All tests
```
