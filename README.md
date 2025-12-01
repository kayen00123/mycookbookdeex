# CookBook Backend

This is the backend service for CookBook, handling order matching, execution, and market data indexing.

## Features

- REST API for order management
- On-chain order matching and settlement
- Market data indexing from GeckoTerminal
- Cross-chain trading support (BSC ↔ Base)
- Conditional orders (stop-loss, take-profit)

## Deployment

### Railway

1. Connect your GitHub repo to Railway
2. Set environment variables in Railway dashboard:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE`
   - `EXECUTOR_RPC_URL` (for BSC)
   - `EXECUTOR_RPC_URL_BASE` (for Base)
   - `EXECUTOR_PRIVATE_KEY` (for settlement execution)
   - `SETTLEMENT_ADDRESS_BSC`
   - `SETTLEMENT_ADDRESS_BASE`
   - `EXECUTOR_ENABLED=true` (to enable order execution)
   - `PORT=8080` (or Railway's default)

3. Railway will automatically install dependencies and start the server with `npm start`

## Local Development

```bash
npm install
npm start
```

## API Endpoints

- `GET /health` - Health check
- `GET /api/markets/wbnb/new` - Market data
- `POST /api/orders` - Place order
- `GET /api/orders` - Get orderbook
- And more...

## Environment Variables

See `.env.example` for required variables.