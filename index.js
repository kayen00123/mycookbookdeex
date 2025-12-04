import express from 'express'
import cors from 'cors'
import fetch from 'node-fetch'
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'
import { Contract as EthContract, JsonRpcProvider, Wallet } from 'ethers'
import path from 'path'
import { fileURLToPath } from 'url'

// Simple indexer service for new WBNB pools on BSC (extensible for other networks)
// Exposes REST endpoints the UI can consume.

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const envPath = path.join(__dirname, '.env')
console.log('[env] Loading .env from:', envPath)
dotenv.config({ path: envPath })
console.log('[env] Node version:', process.version)
console.log('[env] SUPABASE_URL loaded:', !!process.env.SUPABASE_URL)
console.log('[env] SUPABASE_SERVICE_ROLE loaded:', !!process.env.SUPABASE_SERVICE_ROLE)
console.log('[env] SUPABASE_URL value:', process.env.SUPABASE_URL?.substring(0, 20) + '...')
const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 5175

// Canonical WBNB/USDT addresses (lowercase) for BSC
const WBNB_ADDRESS = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'
const USDT_ADDRESS = '0x55d398326f99059ff775485246999027b3197955'

// Canonical WETH/USDC addresses (lowercase) for Base
const WETH_ADDRESS_BASE = '0x4200000000000000000000000000000000000006'
const USDC_ADDRESS_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

// Chainlink BNB/USD price feed for BSC
const CHAINLINK_BNB_USD_ADDRESS = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE'

// Chainlink ETH/USD price feed for Base
const CHAINLINK_ETH_USD_ADDRESS_BASE = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'
const CHAINLINK_ABI = [
  { inputs: [], name: 'latestRoundData', outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }], stateMutability: 'view', type: 'function' }
]

// Supabase configuration
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } }) : null
let SUPABASE_ENABLED = !!supabase
// Debug: log env presence (never log secrets)
console.log('[Supabase] URL set:', !!SUPABASE_URL, 'SERVICE_ROLE set:', !!SUPABASE_SERVICE_ROLE)
console.log('[Supabase] Client created:', !!supabase)

// Known quote logos (direct URLs)
const KNOWN_LOGOS = {
  [WBNB_ADDRESS]: 'https://assets.trustwalletapp.com/blockchains/smartchain/assets/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c/logo.png',
  [USDT_ADDRESS]: 'https://assets.trustwalletapp.com/blockchains/smartchain/assets/0x55d398326f99059fF775485246999027B3197955/logo.png',
  [WETH_ADDRESS_BASE]: 'https://assets.trustwalletapp.com/blockchains/base/assets/0x4200000000000000000000000000000000000006/logo.png',
  [USDC_ADDRESS_BASE]: 'https://assets.trustwalletapp.com/blockchains/base/assets/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/logo.png'
}

// Settlement config for executor
const SETTLEMENT_ADDRESS_BSC = process.env.SETTLEMENT_ADDRESS_BSC || '0x7DBA6a1488356428C33cC9fB8Ef3c8462c8679d0'
const SETTLEMENT_ADDRESS_BASE = process.env.SETTLEMENT_ADDRESS_BASE || '0xBBf7A39F053BA2B8F4991282425ca61F2D871f45'
const SETTLEMENT_ABI = [
  // custom errors
  { "inputs": [], "name": "BadSignature", "type": "error" },
  { "inputs": [], "name": "Expired", "type": "error" },
  { "inputs": [], "name": "InvalidOrder", "type": "error" },
  { "inputs": [], "name": "Overfill", "type": "error" },
  { "inputs": [], "name": "PriceTooLow", "type": "error" },

  // events
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "bytes32", "name": "buyHash", "type": "bytes32" },
      { "indexed": true, "internalType": "bytes32", "name": "sellHash", "type": "bytes32" },
      { "indexed": true, "internalType": "address", "name": "matcher", "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "amountBase", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "amountQuote", "type": "uint256" }
    ],
    "name": "Matched",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "maker", "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "newMinNonce", "type": "uint256" }
    ],
    "name": "MinNonceUpdated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "bytes32", "name": "orderHash", "type": "bytes32" },
      { "indexed": true, "internalType": "address", "name": "maker", "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "nonce", "type": "uint256" }
    ],
    "name": "OrderCancelled",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "bytes32", "name": "orderHash", "type": "bytes32" },
      { "indexed": true, "internalType": "address", "name": "maker", "type": "address" },
      { "indexed": true, "internalType": "address", "name": "taker", "type": "address" },
      { "indexed": false, "internalType": "address", "name": "tokenIn", "type": "address" },
      { "indexed": false, "internalType": "address", "name": "tokenOut", "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "amountIn", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "amountOut", "type": "uint256" }
    ],
    "name": "OrderFilled",
    "type": "event"
  },

  // constant / view getters
  { "inputs": [], "name": "DOMAIN_SEPARATOR", "outputs": [{ "internalType": "bytes32", "name": "", "type": "bytes32" }], "stateMutability": "view", "type": "function" },
  { "inputs": [], "name": "ORDER_TYPEHASH", "outputs": [{ "internalType": "bytes32", "name": "", "type": "bytes32" }], "stateMutability": "view", "type": "function" },

  // availableToFill(order) => uint256
  {
    "inputs": [
      {
        "components": [
          { "internalType": "address", "name": "maker", "type": "address" },
          { "internalType": "address", "name": "tokenIn", "type": "address" },
          { "internalType": "address", "name": "tokenOut", "type": "address" },
          { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
          { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
          { "internalType": "uint256", "name": "expiration", "type": "uint256" },
          { "internalType": "uint256", "name": "nonce", "type": "uint256" },
          { "internalType": "address", "name": "receiver", "type": "address" },
          { "internalType": "uint256", "name": "salt", "type": "uint256" }
        ],
        "internalType": "struct OrderBook.Order",
        "name": "order",
        "type": "tuple"
      }
    ],
    "name": "availableToFill",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },

  // cancelOrder(order)
  {
    "inputs": [
      {
        "components": [
          { "internalType": "address", "name": "maker", "type": "address" },
          { "internalType": "address", "name": "tokenIn", "type": "address" },
          { "internalType": "address", "name": "tokenOut", "type": "address" },
          { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
          { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
          { "internalType": "uint256", "name": "expiration", "type": "uint256" },
          { "internalType": "uint256", "name": "nonce", "type": "uint256" },
          { "internalType": "address", "name": "receiver", "type": "address" },
          { "internalType": "uint256", "name": "salt", "type": "uint256" }
        ],
        "internalType": "struct OrderBook.Order",
        "name": "order",
        "type": "tuple"
      }
    ],
    "name": "cancelOrder",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },

  // cancelled(bytes32) => bool
  { "inputs": [{ "internalType": "bytes32", "name": "", "type": "bytes32" }], "name": "cancelled", "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }], "stateMutability": "view", "type": "function" },

  // fillOrder(order, signature, amountInToFill, takerMinAmountOut)
  {
    "inputs": [
      {
        "components": [
          { "internalType": "address", "name": "maker", "type": "address" },
          { "internalType": "address", "name": "tokenIn", "type": "address" },
          { "internalType": "address", "name": "tokenOut", "type": "address" },
          { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
          { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
          { "internalType": "uint256", "name": "expiration", "type": "uint256" },
          { "internalType": "uint256", "name": "nonce", "type": "uint256" },
          { "internalType": "address", "name": "receiver", "type": "address" },
          { "internalType": "uint256", "name": "salt", "type": "uint256" }
        ],
        "internalType": "struct OrderBook.Order",
        "name": "order",
        "type": "tuple"
      },
      { "internalType": "bytes", "name": "signature", "type": "bytes" },
      { "internalType": "uint256", "name": "amountInToFill", "type": "uint256" },
      { "internalType": "uint256", "name": "takerMinAmountOut", "type": "uint256" }
    ],
    "name": "fillOrder",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },

  // filledAmountIn(bytes32) => uint256
  { "inputs": [{ "internalType": "bytes32", "name": "", "type": "bytes32" }], "name": "filledAmountIn", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },

  // getOrderDigest(order) => bytes32
  {
    "inputs": [
      {
        "components": [
          { "internalType": "address", "name": "maker", "type": "address" },
          { "internalType": "address", "name": "tokenIn", "type": "address" },
          { "internalType": "address", "name": "tokenOut", "type": "address" },
          { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
          { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
          { "internalType": "uint256", "name": "expiration", "type": "uint256" },
          { "internalType": "uint256", "name": "nonce", "type": "uint256" },
          { "internalType": "address", "name": "receiver", "type": "address" },
          { "internalType": "uint256", "name": "salt", "type": "uint256" }
        ],
        "internalType": "struct OrderBook.Order",
        "name": "order",
        "type": "tuple"
      }
    ],
    "name": "getOrderDigest",
    "outputs": [{ "internalType": "bytes32", "name": "", "type": "bytes32" }],
    "stateMutability": "view",
    "type": "function"
  },

  // hashOrder(order) => bytes32 (pure)
  {
    "inputs": [
      {
        "components": [
          { "internalType": "address", "name": "maker", "type": "address" },
          { "internalType": "address", "name": "tokenIn", "type": "address" },
          { "internalType": "address", "name": "tokenOut", "type": "address" },
          { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
          { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
          { "internalType": "uint256", "name": "expiration", "type": "uint256" },
          { "internalType": "uint256", "name": "nonce", "type": "uint256" },
          { "internalType": "address", "name": "receiver", "type": "address" },
          { "internalType": "uint256", "name": "salt", "type": "uint256" }
        ],
        "internalType": "struct OrderBook.Order",
        "name": "order",
        "type": "tuple"
      }
    ],
    "name": "hashOrder",
    "outputs": [{ "internalType": "bytes32", "name": "", "type": "bytes32" }],
    "stateMutability": "pure",
    "type": "function"
  },

  // matchOrders(buy, sigBuy, sell, sigSell, amountBase, amountQuote)
  {
    "inputs": [
      {
        "components": [
          { "internalType": "address", "name": "maker", "type": "address" },
          { "internalType": "address", "name": "tokenIn", "type": "address" },
          { "internalType": "address", "name": "tokenOut", "type": "address" },
          { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
          { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
          { "internalType": "uint256", "name": "expiration", "type": "uint256" },
          { "internalType": "uint256", "name": "nonce", "type": "uint256" },
          { "internalType": "address", "name": "receiver", "type": "address" },
          { "internalType": "uint256", "name": "salt", "type": "uint256" }
        ],
        "internalType": "struct OrderBook.Order",
        "name": "buy",
        "type": "tuple"
      },
      { "internalType": "bytes", "name": "sigBuy", "type": "bytes" },
      {
        "components": [
          { "internalType": "address", "name": "maker", "type": "address" },
          { "internalType": "address", "name": "tokenIn", "type": "address" },
          { "internalType": "address", "name": "tokenOut", "type": "address" },
          { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
          { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
          { "internalType": "uint256", "name": "expiration", "type": "uint256" },
          { "internalType": "uint256", "name": "nonce", "type": "uint256" },
          { "internalType": "address", "name": "receiver", "type": "address" },
          { "internalType": "uint256", "name": "salt", "type": "uint256" }
        ],
        "internalType": "struct OrderBook.Order",
        "name": "sell",
        "type": "tuple"
      },
      { "internalType": "bytes", "name": "sigSell", "type": "bytes" },
      { "internalType": "uint256", "name": "amountBase", "type": "uint256" },
      { "internalType": "uint256", "name": "amountQuote", "type": "uint256" }
    ],
    "name": "matchOrders",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },

  // minAmountOutFor(order, amountInToFill) => uint256 (pure)
  {
    "inputs": [
      {
        "components": [
          { "internalType": "address", "name": "maker", "type": "address" },
          { "internalType": "address", "name": "tokenIn", "type": "address" },
          { "internalType": "address", "name": "tokenOut", "type": "address" },
          { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
          { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
          { "internalType": "uint256", "name": "expiration", "type": "uint256" },
          { "internalType": "uint256", "name": "nonce", "type": "uint256" },
          { "internalType": "address", "name": "receiver", "type": "address" },
          { "internalType": "uint256", "name": "salt", "type": "uint256" }
        ],
        "internalType": "struct OrderBook.Order",
        "name": "o",
        "type": "tuple"
      },
      { "internalType": "uint256", "name": "amountInToFill", "type": "uint256" }
    ],
    "name": "minAmountOutFor",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "pure",
    "type": "function"
  },

  // minNonce(address) => uint256
  { "inputs": [{ "internalType": "address", "name": "", "type": "address" }], "name": "minNonce", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },

  // setMinNonce(newMinNonce)
  { "inputs": [{ "internalType": "uint256", "name": "newMinNonce", "type": "uint256" }], "name": "setMinNonce", "outputs": [], "stateMutability": "nonpayable", "type": "function" },

  // verifySignature(order, sig) => bool
  {
    "inputs": [
      {
        "components": [
          { "internalType": "address", "name": "maker", "type": "address" },
          { "internalType": "address", "name": "tokenIn", "type": "address" },
          { "internalType": "address", "name": "tokenOut", "type": "address" },
          { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
          { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
          { "internalType": "uint256", "name": "expiration", "type": "uint256" },
          { "internalType": "uint256", "name": "nonce", "type": "uint256" },
          { "internalType": "address", "name": "receiver", "type": "address" },
          { "internalType": "uint256", "name": "salt", "type": "uint256" }
        ],
        "internalType": "struct OrderBook.Order",
        "name": "o",
        "type": "tuple"
      },
      { "internalType": "bytes", "name": "sig", "type": "bytes" }
    ],
    "name": "verifySignature",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "view",
    "type": "function"
  }
];


// Minimal ERC20 interface for diagnostics
const ERC20_ABI = [
  { inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], name: 'allowance', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'decimals', outputs: [{ type: 'uint8' }], stateMutability: 'view', type: 'function' }
]

// Network -> chainId helper
function networkToChainId(net) {
  const n = (net || '').toLowerCase()
  if (n === 'bsc' || n === 'bsc-mainnet' || n === 'bnb' || n === 'bnb-smart-chain' || n === 'binance') return 56
  if (n === 'base' || n === 'base-mainnet') return 8453
  // Extend with other networks as needed
  return null
}

// Token info cache to avoid repeated external calls
const tokenInfoCache = new Map() // key: lowercase address -> { symbol, name, logoUrl, ts }

// Fetch BNB/USD price from Chainlink for BSC
async function getBnbUsdPrice() {
  const now = Date.now()
  if (bnbUsdPrice && (now - bnbUsdPriceLastFetched) < BNB_USD_CACHE_TTL) {
    return bnbUsdPrice
  }

  try {
    const provider = new JsonRpcProvider('https://bsc-dataseed.binance.org/')
    const contract = new EthContract(CHAINLINK_BNB_USD_ADDRESS, CHAINLINK_ABI, provider)
    const [, answer] = await contract.latestRoundData()
    const price = Number(answer) / 1e8 // Chainlink feeds return 8 decimals
    bnbUsdPrice = price
    bnbUsdPriceLastFetched = now
    console.log('[Chainlink] BNB/USD price:', price)
    return price
  } catch (e) {
    console.warn('[Chainlink] Failed to fetch BNB/USD price:', e?.message || e)
    return bnbUsdPrice || 300 // fallback to approximate price
  }
}

// Fetch ETH/USD price from Chainlink for Base
async function getEthUsdPrice() {
  const now = Date.now()
  if (ethUsdPrice && (now - ethUsdPriceLastFetched) < ETH_USD_CACHE_TTL) {
    return ethUsdPrice
  }

  try {
    const provider = new JsonRpcProvider('https://mainnet.base.org')
    const contract = new EthContract(CHAINLINK_ETH_USD_ADDRESS_BASE, CHAINLINK_ABI, provider)
    const [, answer] = await contract.latestRoundData()
    const price = Number(answer) / 1e8 // Chainlink feeds return 8 decimals
    ethUsdPrice = price
    ethUsdPriceLastFetched = now
    console.log('[Chainlink] ETH/USD price:', price)
    return price
  } catch (e) {
    console.warn('[Chainlink] Failed to fetch ETH/USD price:', e?.message || e)
    return ethUsdPrice || 3000 // fallback to approximate price
  }
}

// Cache for ETH/USD price
let ethUsdPrice = null
let ethUsdPriceLastFetched = 0
const ETH_USD_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// Probe Supabase connectivity once; disable DB usage if unreachable
;(async () => {
  if (!supabase) { SUPABASE_ENABLED = false; return }
  try {
    // Accept 401/403/404 as "reachable" since we don't send auth headers in this HEAD probe
    const ping = await fetch(`${SUPABASE_URL}/rest/v1/`, { method: 'HEAD' })
    SUPABASE_ENABLED = ping.ok || [401, 403, 404].includes(ping.status)
    if (!SUPABASE_ENABLED) console.warn('Supabase not reachable, DB features disabled (status:', ping.status, ')')
  } catch (e) {
    SUPABASE_ENABLED = false
    console.warn('Supabase connectivity check failed, DB features disabled')
    console.error('[Supabase] connectivity error:', e?.message || e)
    console.error('[Supabase] URL:', SUPABASE_URL)
  }
})()

// In-memory caches
const marketsCache = {
  // network: { updatedAt: number, data: Array<Market> }
}

// Cache for BNB/USD price
let bnbUsdPrice = null
let bnbUsdPriceLastFetched = 0
const BNB_USD_CACHE_TTL = 5 * 60 * 1000 // 5 minutes
// In-memory orders fallback when DB is unreachable
const ordersMem = []

// Types (for reference)
// type Market = {
//   base: { symbol: string, address: string, decimals: number }
//   quote: { symbol: 'WBNB', address: string, decimals: number }
//   pair: string
//   price: string
//   change: string
//   volume: string
//   poolAddress: string
//   geckoPoolId: string
// }

// Fetch trending pools from GeckoTerminal
async function fetchTrendingPoolsFromGecko({ network = 'bsc', pages = 1, duration = '1h' }) {
  const results = []
  for (let page = 1; page <= pages; page++) {
    const url = `https://api.geckoterminal.com/api/v2/networks/${network}/trending_pools?include=base_token,quote_token&page=${page}&duration=${encodeURIComponent(duration)}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`)
    const json = await res.json()
    results.push(json)
    if (!json?.data?.length) break
  }
  return results
}

// Fetch new pools from GeckoTerminal
async function fetchNewPoolsFromGecko({ network = 'bsc', pages = 1 }) {
  const results = []
  for (let page = 1; page <= pages; page++) {
    const url = `https://api.geckoterminal.com/api/v2/networks/${network}/new_pools?include=base_token,quote_token&page=${page}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`GeckoTerminal new pools HTTP ${res.status}`)
    const json = await res.json()
    results.push(json)
    if (!json?.data?.length) break
  }
  return results
}

function mapGeckoToMarkets(geckoPages, network = 'bsc') {
  const markets = []
  for (const page of geckoPages) {
    const pools = page?.data || []
    const included = page?.included || []
    const findIncluded = (type, id) => included.find(x => x.type === type && x.id === id)

    for (const p of pools) {
      const attr = p.attributes || {}
      const rel = p.relationships || {}
      const baseRef = rel.base_token?.data
      const quoteRef = rel.quote_token?.data
      const baseInc = baseRef ? findIncluded('tokens', baseRef.id) : null
      const quoteInc = quoteRef ? findIncluded('tokens', quoteRef.id) : null
      const baseTok = baseInc?.attributes || {}
      const quoteTok = quoteInc?.attributes || {}

      const poolAddress = attr.address?.toLowerCase?.() || ''
      const name = (attr.name || '').trim()
      let left = ''
      let right = ''
      if (name.includes('/')) {
        const parts = name.split('/')
        left = (parts[0] || '').trim()
        right = (parts[1] || '').trim()
        // Strip fee (e.g., "USDT 0.007%")
        right = right.split(' ')[0]
      }

      const baseSymbol = baseTok.symbol || left || 'TOKEN'
      const quoteSymbol = quoteTok.symbol || right || 'TOKEN'
      const baseAddress = baseTok.address || (baseRef?.id?.split('_')[1] || null)
      const quoteAddress = quoteTok.address || (quoteRef?.id?.split('_')[1] || null)
      const baseDecimals = Number(baseTok.decimals || 18)
      const quoteDecimals = Number(quoteTok.decimals || 18)

      // Exclude pools based on network
      const baseSymU = (baseSymbol || '').toUpperCase()
      const quoteSymU = (quoteSymbol || '').toUpperCase()
      if (network === 'bsc') {
        // Exclude any pools where either side is native BNB (not WBNB)
        if (baseSymU === 'BNB' || quoteSymU === 'BNB') {
          continue
        }
      } else if (network === 'base') {
        // Exclude any pools where quote is ETH (but allow WETH)
        if (quoteSymU === 'ETH') {
          continue
        }
      }

      const price = attr.price_usd || attr.token_price_usd || '0'
      const change = attr.price_change_percentage?.h24 || '0.00'
      const volume = attr.volume_usd?.h24 || '0'

      markets.push({
        base: { symbol: baseSymbol, address: baseAddress, decimals: baseDecimals },
        quote: { symbol: quoteSymbol, address: quoteAddress, decimals: quoteDecimals },
        pair: `${baseSymbol}/${quoteSymbol}`,
        price: price === '0' ? '-' : Number(price).toFixed(6),
        change: '0.00', // Will be computed from orderbook trades
        volume: '0', // Will be computed from orderbook trades
        poolAddress,
        geckoPoolId: `${network}/pools/${poolAddress}`
      })
    }
  }
  // Deduplicate by poolAddress
  const byPool = new Map()
  for (const m of markets) {
    if (!byPool.has(m.poolAddress)) byPool.set(m.poolAddress, m)
  }
  return Array.from(byPool.values())
}

// Optional enrichment using GeckoTerminal token info to fill symbol/logo
async function fetchTokenInfo(network, address) {
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/info`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Token info HTTP ${res.status}`)
  const json = await res.json()
  const attrs = json?.data?.attributes || {}
  return {
    symbol: attrs.symbol || null,
    name: attrs.name || null,
    decimals: (typeof attrs.decimals === 'number' ? attrs.decimals : null),
    logoUrl: (attrs.image && (attrs.image.large || attrs.image.small || attrs.image.thumb)) || attrs.image_url || null
  }
}

async function getTokenInfoCached(network, address) {
  const key = (address || '').toLowerCase()
  if (!key) return null
  const cached = tokenInfoCache.get(key)
  const now = Date.now()
  if (cached && (now - (cached.ts || 0) < 15 * 60 * 1000)) return cached // 15 min TTL
  try {
    const info = await fetchTokenInfo(network, key)
    const record = { ...info, ts: now }
    tokenInfoCache.set(key, record)
    return record
  } catch {
    return null
  }
}

async function enrichMarketsWithTokenInfo(network, markets) {
  const enriched = [...markets]
  for (const m of enriched) {
    // Symbol-based fallback mapping for native BNB/WBNB with missing address
    try {
      const bSym = (m?.base?.symbol || '').toUpperCase()
      const qSym = (m?.quote?.symbol || '').toUpperCase()
      if ((!m?.base?.address) && (bSym === 'BNB' || bSym === 'WBNB')) {
        m.base.address = WBNB_ADDRESS
        if (m.base.decimals == null) m.base.decimals = 18
        if (!m.base.logoUrl && KNOWN_LOGOS[WBNB_ADDRESS]) m.base.logoUrl = KNOWN_LOGOS[WBNB_ADDRESS]
      }
      if ((!m?.quote?.address) && (qSym === 'BNB' || qSym === 'WBNB')) {
        m.quote.address = WBNB_ADDRESS
        if (m.quote.decimals == null) m.quote.decimals = 18
        if (!m.quote.logoUrl && KNOWN_LOGOS[WBNB_ADDRESS]) m.quote.logoUrl = KNOWN_LOGOS[WBNB_ADDRESS]
      }
      if (m.base?.symbol && m.quote?.symbol) m.pair = `${m.base.symbol}/${m.quote.symbol}`
    } catch {}
    // Base token enrichment: fetch symbol/logo/name/decimals if missing
    if (m?.base?.address && (!m.base.logoUrl || !m.base.symbol || m.base.decimals == null)) {
      const info = await getTokenInfoCached(network, m.base.address)
      if (info) {
        if (!m.base.symbol && info.symbol) m.base.symbol = info.symbol
        if (info.logoUrl) m.base.logoUrl = info.logoUrl
        if (info.name) m.base.name = info.name
        if ((m.base.decimals == null || Number.isNaN(m.base.decimals)) && info.decimals != null) m.base.decimals = Number(info.decimals)
        // Update pair if base or quote symbol impacted
        if (m.base.symbol && m.quote?.symbol) m.pair = `${m.base.symbol}/${m.quote.symbol}`
      }
    }

    // Quote token enrichment: fetch symbol/logo/name/decimals if missing
    if (m?.quote?.address && (!m.quote.logoUrl || !m.quote.symbol || m.quote.decimals == null)) {
      const infoQ = await getTokenInfoCached(network, m.quote.address)
      if (infoQ) {
        if (!m.quote.symbol && infoQ.symbol) m.quote.symbol = infoQ.symbol
        if (infoQ.logoUrl) m.quote.logoUrl = infoQ.logoUrl
        if (infoQ.name) m.quote.name = infoQ.name
        if ((m.quote.decimals == null || Number.isNaN(m.quote.decimals)) && infoQ.decimals != null) m.quote.decimals = Number(infoQ.decimals)
        if (m.base?.symbol && m.quote.symbol) m.pair = `${m.base.symbol}/${m.quote.symbol}`
      }
    }

    // Override/ensure known logos for canonical quotes (e.g., WBNB/USDT, WETH/USDC)
    const qAddr = (m?.quote?.address || '').toLowerCase()
    if (KNOWN_LOGOS[qAddr]) {
      m.quote.logoUrl = KNOWN_LOGOS[qAddr]
    }
  }
  return enriched
}

// Ensure logos present for markets by consulting tokens table, known logos, and GeckoTerminal as fallback
async function ensureLogos(network, markets) {
  try {
    if (!SUPABASE_ENABLED) return markets
    const need = []
    for (const m of markets || []) {
      const bAddr = (m?.base?.address || '').toLowerCase()
      const qAddr = (m?.quote?.address || '').toLowerCase()
      if (bAddr && !m.base.logoUrl) need.push({ addr: bAddr, network: network === 'crosschain' ? (bAddr === WBNB_ADDRESS ? 'bsc' : 'base') : network })
      if (qAddr && !m.quote.logoUrl) need.push({ addr: qAddr, network: network === 'crosschain' ? (qAddr === USDC_ADDRESS_BASE ? 'base' : 'bsc') : network })
    }
    const unique = Array.from(new Set(need.map(x => x.addr)))
    const logoByAddr = {}

    // 1) Known logos override
    for (const addr of unique) {
      if (KNOWN_LOGOS[addr]) logoByAddr[addr] = KNOWN_LOGOS[addr]
    }

    // 2) Pull from tokens table (try both networks for crosschain)
    if (unique.length) {
      try {
        const networksToCheck = network === 'crosschain' ? ['bsc', 'base'] : [network]
        for (const net of networksToCheck) {
          const { data, error } = await supabase
            .from('tokens')
            .select('address, logo_url')
            .eq('network', net)
            .in('address', unique)
          if (!error) {
            for (const row of data || []) {
              const a = (row.address || '').toLowerCase()
              if (row.logo_url && !logoByAddr[a]) logoByAddr[a] = row.logo_url
            }
          }
        }
      } catch {}
    }

    // 3) Fetch from GeckoTerminal for any still missing, and persist back to tokens
    const toFetch = need.filter(x => !logoByAddr[x.addr])
    const fetchedRows = []
    for (const item of toFetch) {
      try {
        const info = await getTokenInfoCached(item.network, item.addr)
        if (info?.logoUrl) {
          logoByAddr[item.addr] = info.logoUrl
          fetchedRows.push({ network: item.network, address: item.addr, logo_url: info.logoUrl, updated_at: new Date().toISOString() })
        }
      } catch {}
    }
    if (fetchedRows.length) {
      try { await supabase.from('tokens').upsert(fetchedRows, { onConflict: 'network,address' }) } catch {}
    }

    // Apply to markets and persist any updates
    const updates = []
    for (const m of markets || []) {
      let changed = false
      const bAddr = (m?.base?.address || '').toLowerCase()
      const qAddr = (m?.quote?.address || '').toLowerCase()
      if (bAddr && !m.base.logoUrl && logoByAddr[bAddr]) { m.base.logoUrl = logoByAddr[bAddr]; changed = true }
      if (qAddr && !m.quote.logoUrl && logoByAddr[qAddr]) { m.quote.logoUrl = logoByAddr[qAddr]; changed = true }
      if (changed) updates.push(m)
    }

    if (updates.length) {
      try { await upsertMarkets(network, updates) } catch {}
    }
    return markets
  } catch {
    return markets
  }
}

// Supabase helpers
async function upsertMarkets(network, markets) {
  if (!supabase || !SUPABASE_ENABLED) return
  const nowIso = new Date().toISOString()
  const rowsExtended = markets.map(m => {
    const b = (m.base?.address || '').toLowerCase()
    const q = (m.quote?.address || '').toLowerCase()
    const pairKey = (b && q) ? (b < q ? `${b}_${q}` : `${q}_${b}`) : null
    return {
      network,
      pool_address: m.poolAddress,
      pair_key: pairKey,
      base_symbol: m.base?.symbol || null,
      base_address: b || null,
      base_decimals: m.base?.decimals ?? null,
      base_name: m.base?.name || null,
      base_logo_url: m.base?.logoUrl || null,
      quote_symbol: m.quote?.symbol || null,
      quote_address: q || null,
      quote_decimals: m.quote?.decimals ?? null,
      quote_name: m.quote?.name || null,
      quote_logo_url: m.quote?.logoUrl || null,
      pair: m.pair || null,
      price: m.price || null,
      change: m.change || null,
      volume: m.volume || null,
      gecko_pool_id: m.geckoPoolId || null,
      updated_at: nowIso
    }
  })
  // Dedupe by pair_key to avoid conflicts in upsert
  const byPairKey = new Map()
  for (const row of rowsExtended) {
    const key = row.pair_key
    if (!key) continue
    if (!byPairKey.has(key)) byPairKey.set(key, row)
    else {
      // Keep the one with more complete data or newer updated_at
      const existing = byPairKey.get(key)
      if ((row.updated_at > existing.updated_at) ||
          (!existing.base_symbol && row.base_symbol) ||
          (!existing.quote_symbol && row.quote_symbol)) {
        byPairKey.set(key, row)
      }
    }
  }
  const dedupedRows = Array.from(byPairKey.values())
  // Primary upsert by (network,pair_key) to ensure one row per pair
  let { error } = await supabase.from('markets').upsert(dedupedRows, { onConflict: 'network,pair_key' })
  if (error) {
    console.warn('[Supabase] markets upsert by pair_key failed; falling back to pool_address. Error:', error.message || error)
    const rowsMinimal = markets.map(m => {
      const b = (m.base?.address || '').toLowerCase()
      const q = (m.quote?.address || '').toLowerCase()
      const pairKey = (b && q) ? (b < q ? `${b}_${q}` : `${q}_${b}`) : null
      return {
        network,
        pool_address: m.poolAddress,
        pair_key: pairKey,
        base_symbol: m.base?.symbol || null,
        base_address: b || null,
        base_decimals: m.base?.decimals ?? null,
        quote_symbol: m.quote?.symbol || null,
        quote_address: q || null,
        quote_decimals: m.quote?.decimals ?? null,
        pair: m.pair || null,
        price: m.price || null,
        change: m.change || null,
        volume: m.volume || null,
        gecko_pool_id: m.geckoPoolId || null,
        updated_at: nowIso
      }
    })
    const res2 = await supabase.from('markets').upsert(rowsMinimal, { onConflict: 'network,pool_address' })
    if (res2.error) throw res2.error
  }
}

// Upsert token metadata into 'tokens' table (if present)
async function upsertTokens(network, markets) {
  if (!supabase || !SUPABASE_ENABLED) return
  const tokens = new Map()
  const chainId = networkToChainId(network)
  for (const m of markets) {
    const b = m.base || {}
    const q = m.quote || {}
    if (b.address) tokens.set(`${network}:${b.address.toLowerCase()}`, {
      network,
      chain_id: chainId,
      address: b.address.toLowerCase(),
      symbol: b.symbol || null,
      name: b.name || null,
      decimals: b.decimals ?? null,
      logo_url: b.logoUrl || null,
      updated_at: new Date().toISOString()
    })
    if (q.address) tokens.set(`${network}:${q.address.toLowerCase()}`, {
      network,
      chain_id: chainId,
      address: q.address.toLowerCase(),
      symbol: q.symbol || null,
      name: q.name || null,
      decimals: q.decimals ?? null,
      logo_url: q.logoUrl || null,
      updated_at: new Date().toISOString()
    })
  }
  const rows = Array.from(tokens.values())
  if (!rows.length) return
  try {
    const { error } = await supabase.from('tokens').upsert(rows, { onConflict: 'network,address' })
    if (error) throw error
  } catch (e) {
    console.warn('[Supabase] tokens upsert failed (table might be missing):', e?.message || e)
  }
}

// Remove any existing BNB pools from DB for a network
async function removeBnbPoolsFromDb(network) {
  if (!supabase || !SUPABASE_ENABLED) return
  try {
    const { error } = await supabase
      .from('markets')
      .delete()
      .eq('network', network)
      .or('base_symbol.eq.BNB,quote_symbol.eq.BNB')
    if (error) throw error
  } catch (e) {
    console.warn('[Supabase] cleanup BNB pools failed:', e?.message || e)
  }
}

async function fetchMarketsFromDb(network, page = 1, limit = 50) {
  if (!supabase || !SUPABASE_ENABLED) return { data: null, total: 0 }
  const offset = (page - 1) * limit

  // Get total count
  const { count, error: countError } = await supabase
    .from('markets')
    .select('*', { count: 'exact', head: true })
    .eq('network', network)
  if (countError) throw countError

  const { data, error } = await supabase
    .from('markets')
    .select('*')
    .eq('network', network)
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) throw error
  const rows = (data || []).map(row => ({
    base: { symbol: row.base_symbol, address: row.base_address, decimals: row.base_decimals, name: row.base_name, logoUrl: row.base_logo_url },
    quote: { symbol: row.quote_symbol, address: row.quote_address, decimals: row.quote_decimals, name: row.quote_name, logoUrl: row.quote_logo_url },
    pair: row.pair,
    price: row.price,
    change: row.change,
    volume: row.volume,
    poolAddress: row.pool_address,
    geckoPoolId: row.gecko_pool_id,
    pairKey: row.pair_key,
    updatedAt: row.updated_at,
    network: row.network
  }))
  // Dedupe by pairKey, keep most recent updatedAt
  const byPair = new Map()
  for (const r of rows) {
    const key = r.pairKey || ((r.base?.address && r.quote?.address) ? ((r.base.address.toLowerCase() < r.quote.address.toLowerCase()) ? `${r.base.address.toLowerCase()}_${r.quote.address.toLowerCase()}` : `${r.quote.address.toLowerCase()}_${r.base.address.toLowerCase()}`) : null)
    if (!key) continue
    if (!byPair.has(key)) byPair.set(key, r)
    else {
      const cur = byPair.get(key)
      if ((new Date(r.updatedAt || 0)) > (new Date(cur.updatedAt || 0))) byPair.set(key, r)
    }
  }
  return { data: Array.from(byPair.values()), total: count || 0 }
}

async function refreshNetwork(network = 'bsc', pages = 2, duration = '1h') {
  // Fetch both trending and new pools
  const [trendingPages, newPages] = await Promise.all([
    fetchTrendingPoolsFromGecko({ network, pages, duration }),
    fetchNewPoolsFromGecko({ network, pages })
  ])

  // Map both to markets format
  const trendingMapped = mapGeckoToMarkets(trendingPages, network)
  const newMapped = mapGeckoToMarkets(newPages, network)

  // Merge and deduplicate by poolAddress
  const allMarkets = [...trendingMapped, ...newMapped]
  const uniqueMarkets = Array.from(
    allMarkets.reduce((map, market) => {
      if (!map.has(market.poolAddress)) {
        map.set(market.poolAddress, market)
      }
      return map
    }, new Map()).values()
  )

  let mapped = uniqueMarkets
  try { mapped = await enrichMarketsWithTokenInfo(network, mapped) } catch {}
  marketsCache[network] = { updatedAt: Date.now(), data: mapped }
  if (SUPABASE_ENABLED) {
    // Ensure DB contains no BNB pools
    try { await removeBnbPoolsFromDb(network) } catch {}
    try { await upsertTokens(network, mapped) } catch (e) { console.error('[Supabase] tokens upsert failed:', e?.message || e) }
    try { await upsertMarkets(network, mapped) } catch (e) { console.error('[Supabase] markets upsert failed:', e?.message || e) }
  }
  return mapped
}

// Check and execute conditional orders
async function checkConditionalOrders(network) {
  if (!SUPABASE_ENABLED) return
  try {
    // Get pending conditional orders
    const { data: conditionalOrders, error } = await supabase
      .from('conditional_orders')
      .select('*')
      .eq('network', network)
      .eq('status', 'pending')
      .is('expiration', null) // or check expiration > now
      .or('expiration.is.null,expiration.gt.' + new Date().toISOString())

    if (error || !conditionalOrders || !conditionalOrders.length) return

    // Get current prices from markets
    const { data: markets, error: marketsError } = await supabase
      .from('markets')
      .select('pair, price')
      .eq('network', network)

    if (marketsError || !markets) return

    const priceMap = new Map()
    for (const m of markets) {
      if (m.price && m.price !== '-') {
        priceMap.set(m.pair, Number(m.price))
      }
    }

    for (const co of conditionalOrders) {
      const pair = co.pair
      const currentPrice = priceMap.get(pair)
      if (currentPrice == null) continue

      const triggerPrice = Number(co.trigger_price)
      let shouldTrigger = false

      if (co.type === 'stop_loss') {
        // For stop loss, trigger if price drops to or below trigger
        shouldTrigger = currentPrice <= triggerPrice
      } else if (co.type === 'take_profit') {
        // For take profit, trigger if price rises to or above trigger
        shouldTrigger = currentPrice >= triggerPrice
      }

      if (shouldTrigger) {
        // Place the order
        const orderTemplate = co.order_template
        if (!orderTemplate.maker || !orderTemplate.tokenIn || !orderTemplate.tokenOut) continue

        // Generate order ID
        const orderId = sha1(JSON.stringify({
          network,
          maker: toLower(orderTemplate.maker),
          nonce: String(orderTemplate.nonce || ''),
          tokenIn: toLower(orderTemplate.tokenIn),
          tokenOut: toLower(orderTemplate.tokenOut),
          salt: String(orderTemplate.salt || '')
        }))

        const orderRow = {
          network,
          order_id: orderId,
          order_hash: orderId,
          maker: toLower(orderTemplate.maker),
          token_in: toLower(orderTemplate.tokenIn),
          token_out: toLower(orderTemplate.tokenOut),
          amount_in: String(orderTemplate.amountIn || '0'),
          amount_out_min: String(orderTemplate.amountOutMin || '0'),
          expiration: orderTemplate.expiration ? new Date(Number(orderTemplate.expiration) * 1000).toISOString() : null,
          nonce: String(orderTemplate.nonce || '0'),
          receiver: toLower(orderTemplate.receiver || ''),
          salt: String(orderTemplate.salt || '0'),
          signature: orderTemplate.signature || '',
          order_json: orderTemplate,
          base: co.base_token,
          quote: co.quote_token,
          base_address: co.base_token,
          quote_address: co.quote_token,
          pair: co.pair,
          side: null,
          price: null,
          remaining: String(orderTemplate.amountIn || '0'),
          status: 'open',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }

        // Insert the order
        const { error: orderError } = await supabase.from('orders').upsert(orderRow, { onConflict: 'network,order_id' })
        if (orderError) {
          console.error('[conditional-orders] failed to place order:', orderError.message)
          continue
        }

        // Update conditional order status
        await supabase
          .from('conditional_orders')
          .update({ status: 'triggered', updated_at: new Date().toISOString() })
          .eq('conditional_order_id', co.conditional_order_id)
          .eq('network', network)

        console.log(`[conditional-orders] triggered ${co.type} for ${co.maker} on ${pair}, placed order ${orderId}`)
      }
    }
  } catch (e) {
    console.error('[conditional-orders] check error:', e?.message || e)
  }
}

// Background refresher
const REFRESH_MS = 600_000 // 10 minutes
setInterval(() => {
  refreshNetwork('bsc', 2, '1h').catch(() => {})
  refreshNetwork('base', 2, '1h').catch(() => {})
  checkConditionalOrders('bsc').catch(() => {})
  checkConditionalOrders('base').catch(() => {})
}, REFRESH_MS)

// Kick-off initial load (non-blocking)
refreshNetwork('bsc', 2, '1h').catch(() => {})
refreshNetwork('base', 2, '1h').catch(() => {})

// Routes
app.get('/health', (req, res) => {
  res.json({ ok: true, time: Date.now() })
})

// Debug endpoint to test crosschain trades query
app.get('/debug/crosschain-trades', async (req, res) => {
  try {
    console.log('[debug] Testing crosschain trades query...')
    console.log('[debug] SUPABASE_ENABLED:', SUPABASE_ENABLED)
    console.log('[debug] supabase client:', !!supabase)
    if (!SUPABASE_ENABLED || !supabase) {
      return res.status(500).json({ error: 'Supabase not enabled or client not initialized' })
    }
    const { data, error } = await supabase
      .from('cross_chain_trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5)
    if (error) {
      console.error('[debug] crosschain trades query error:', error)
      return res.status(500).json({ error: error.message, code: error.code, details: error.details })
    }
    console.log('[debug] crosschain trades query success, found', data?.length || 0, 'trades')
    return res.json({ success: true, count: data?.length || 0, data })
  } catch (e) {
    console.error('[debug] crosschain trades exception:', e)
    return res.status(500).json({ error: e.message, stack: e.stack })
  }
})

// Fills API: query fills by orderId, or list recent fills for a pair
app.get('/api/fills', async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(503).json({ error: 'database disabled' })
    const network = (req.query.network || 'bsc').toString()
    const orderId = (req.query.orderId || '').toString()
    const base = (req.query.base || '').toString().toLowerCase()
    const quote = (req.query.quote || '').toString().toLowerCase()
    const since = (req.query.since || '').toString()
    const limit = Math.min(Number(req.query.limit || 20), 1000)

    let rows = []

    if (network === 'crosschain') {
      console.log('[DEBUG] /api/fills crosschain query, network:', network, 'base:', base, 'quote:', quote)
      // For crosschain, query cross_chain_trades table
      let query = supabase
        .from('cross_chain_trades')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit)

      if (since) {
        query = query.gte('created_at', since)
      }

      const { data, error } = await query
      if (error) throw error
      console.log('[DEBUG] crosschain query result, data length:', data?.length || 0)

      // For crosschain, we know the pair is WBNB/USDC
      const crosschainBase = WBNB_ADDRESS
      const crosschainQuote = USDC_ADDRESS_BASE
      const baseDecimals = 18 // WBNB
      const quoteDecimals = 6  // USDC

      rows = (data || []).map(r => ({
        network: 'crosschain',
        amountBase: r.amount_base,
        amountQuote: r.amount_quote,
        // For crosschain, use settlement tx hashes (transfers from executor to parties)
        txHash: r.tx_hash_buy || r.tx_hash_sell,
        blockNumber: r.block_number_buy || r.block_number_sell,
        createdAt: r.created_at,
        // Convert amounts to readable format
        amountBaseReadable: r.amount_base ? (Number(r.amount_base) / Math.pow(10, baseDecimals)).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '0',
        amountQuoteReadable: r.amount_quote ? (Number(r.amount_quote) / Math.pow(10, quoteDecimals)).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '0',
        // Include all transaction details for crosschain
        crosschainDetails: {
          txHashes: {
            buySettlement: r.tx_hash_buy, // buyer receives base
            sellSettlement: r.tx_hash_sell // seller receives quote
          },
          blockNumbers: {
            buySettlement: r.block_number_buy,
            sellSettlement: r.block_number_sell
          },
          networks: {
            buy: r.buy_network,
            sell: r.sell_network
          }
        }
      }))

      // Filter by pair if specified (for crosschain, it's always WBNB/USDC)
      if (base && quote) {
        console.log('[DEBUG] filtering by pair, base:', base, 'quote:', quote, 'crosschainBase:', crosschainBase, 'crosschainQuote:', crosschainQuote)
        if (!(base === crosschainBase && quote === crosschainQuote)) {
          console.log('[DEBUG] pair does not match, setting rows to empty')
          rows = [] // No matches for other pairs in crosschain
        } else {
          console.log('[DEBUG] pair matches, rows length after filter:', rows.length)
        }
      }
    } else {
      // For regular networks, query fills table
      let query = supabase
        .from('fills')
        .select('*')
        .eq('network', network)
        .order('created_at', { ascending: false })

      if (orderId) {
        query = query.or(`buy_order_id.eq.${orderId},sell_order_id.eq.${orderId}`)
        query = query.limit(limit)
      } else if (base && quote) {
        // For pair-based queries, fetch all fills and filter client-side
        // Since fills table doesn't have base/quote directly, we'll fetch all and filter client-side for now
        // In production, consider adding base/quote to fills table or using a view
      } else {
        query = query.limit(limit)
      }

      if (since) {
        query = query.gte('created_at', since)
      }

      const { data, error } = await query
      if (error) throw error

      // Determine decimals if base/quote provided by looking up markets table
      let baseDecimals = 18
      let quoteDecimals = 18
      if (base && quote) {
        // Canonical overrides for known tokens
        if (network === 'base') {
          if (base === WETH_ADDRESS_BASE) baseDecimals = 18
          if (quote === USDC_ADDRESS_BASE) quoteDecimals = 6
          if (base === USDC_ADDRESS_BASE) baseDecimals = 6
          if (quote === WETH_ADDRESS_BASE) quoteDecimals = 18
        } else if (network === 'bsc') {
          if (base === WBNB_ADDRESS) baseDecimals = 18
          if (quote === USDT_ADDRESS) quoteDecimals = 18
          if (base === USDT_ADDRESS) baseDecimals = 18
          if (quote === WBNB_ADDRESS) quoteDecimals = 18
        }

        // Fallback to markets table if not canonical
        if (baseDecimals === 18 && quoteDecimals === 18) {
          try {
            const { data: m } = await supabase
              .from('markets')
              .select('base_address, quote_address, base_decimals, quote_decimals')
              .eq('network', network)
              .or(`and(base_address.eq.${base},quote_address.eq.${quote}),and(base_address.eq.${quote},quote_address.eq.${base})`)
              .limit(1)
            if (m && m[0]) {
              // If reversed match, still use base/quote from request for decimals mapping
              const row = m[0]
              if ((row.base_address || '').toLowerCase() === base && (row.quote_address || '').toLowerCase() === quote) {
                baseDecimals = Number(row.base_decimals ?? 18)
                quoteDecimals = Number(row.quote_decimals ?? 18)
              } else if ((row.base_address || '').toLowerCase() === quote && (row.quote_address || '').toLowerCase() === base) {
                // Swap because the request was reversed relative to markets row
                baseDecimals = Number(row.quote_decimals ?? 18)
                quoteDecimals = Number(row.base_decimals ?? 18)
              }
            }
          } catch {}
        }
      }

      const rowsRaw = data || []

      let tempRows = rowsRaw.map(r => ({
        network: r.network,
        buyOrderId: r.buy_order_id,
        sellOrderId: r.sell_order_id,
        amountBase: r.amount_base,
        amountQuote: r.amount_quote,
        txHash: r.tx_hash,
        blockNumber: r.block_number,
        createdAt: r.created_at,
        // Convert amounts to readable format using detected decimals (fallback 18)
        amountBaseReadable: r.amount_base ? (Number(r.amount_base) / Math.pow(10, baseDecimals)).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '0',
        amountQuoteReadable: r.amount_quote ? (Number(r.amount_quote) / Math.pow(10, quoteDecimals)).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '0'
      }))

      // If querying by pair, filter client-side (temporary solution)
      if (!orderId && base && quote) {
        // Get order details for each fill to check base/quote
        const orderIds = new Set()
        tempRows.forEach(r => {
          orderIds.add(r.buyOrderId)
          orderIds.add(r.sellOrderId)
        })

        if (orderIds.size > 0) {
          const { data: orderData, error: orderError } = await supabase
            .from('orders')
            .select('order_id, base, quote')
            .in('order_id', Array.from(orderIds))
            .limit(1000) // Allow more orders for filtering
          if (!orderError && orderData) {
            const orderMap = new Map()
            orderData.forEach(o => orderMap.set(o.order_id, { base: o.base, quote: o.quote }))

            tempRows = tempRows.filter(r => {
              const buyOrder = orderMap.get(r.buyOrderId)
              const sellOrder = orderMap.get(r.sellOrderId)
              return buyOrder && sellOrder &&
                     buyOrder.base === base && buyOrder.quote === quote &&
                     sellOrder.base === base && sellOrder.quote === quote
            })
          }
        }
        // Apply limit after filtering
        rows = tempRows.slice(0, limit)
      } else {
        rows = tempRows
      }
    }

    return res.json({ network, orderId, base, quote, data: rows })
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) })
  }
})

app.get('/api/fills/recent', async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(503).json({ error: 'database disabled' })
    const network = (req.query.network || 'bsc').toString()
    const base = (req.query.base || '').toString().toLowerCase()
    const quote = (req.query.quote || '').toString().toLowerCase()
    const limit = Math.min(Number(req.query.limit || 20), 100)
    const { data, error } = await supabase
      .from('fills')
      .select('*')
      .eq('network', network)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw error

    // Determine decimals if base/quote provided
    let baseDecimals = 18
    let quoteDecimals = 18
    if (base && quote) {
      try {
        const { data: m } = await supabase
          .from('markets')
          .select('base_address, quote_address, base_decimals, quote_decimals')
          .eq('network', network)
          .or(`and(base_address.eq.${base},quote_address.eq.${quote}),and(base_address.eq.${quote},quote_address.eq.${base})`)
          .limit(1)
        if (m && m[0]) {
          const row = m[0]
          if ((row.base_address || '').toLowerCase() === base && (row.quote_address || '').toLowerCase() === quote) {
            baseDecimals = Number(row.base_decimals ?? 18)
            quoteDecimals = Number(row.quote_decimals ?? 18)
          } else if ((row.base_address || '').toLowerCase() === quote && (row.quote_address || '').toLowerCase() === base) {
            baseDecimals = Number(row.quote_decimals ?? 18)
            quoteDecimals = Number(row.base_decimals ?? 18)
          }
        }
      } catch {}
    }

    const rows = (data || []).map(r => ({
      network: r.network,
      buyOrderId: r.buy_order_id,
      sellOrderId: r.sell_order_id,
      amountBase: r.amount_base,
      amountQuote: r.amount_quote,
      txHash: r.tx_hash,
      blockNumber: r.block_number,
      createdAt: r.created_at,
      amountBaseReadable: r.amount_base ? (Number(r.amount_base) / Math.pow(10, baseDecimals)).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '0',
      amountQuoteReadable: r.amount_quote ? (Number(r.amount_quote) / Math.pow(10, quoteDecimals)).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '0'
    }))
    return res.json({ network, data: rows })
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) })
  }
})

// Current cached markets with trading stats from fills
app.get('/api/markets/wbnb/new', async (req, res) => {
  try {
    const network = (req.query.network || 'bsc').toString()
    const pages = Number(req.query.pages || 2)
    const duration = (req.query.duration || '1h').toString()
    const page = Math.max(1, Number(req.query.page || 1))
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 50))) // Limit to 50 per page for performance

    // Get base markets data
    let markets = []
    let totalCount = 0

    // For crosschain network, skip GeckoTerminal and use hardcoded pair
    if (network === 'crosschain') {
      markets.push({
        base: { symbol: 'WBNB', address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', decimals: 18, network: 'bsc' },
        quote: { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, network: 'base' },
        pair: 'WBNB/USDC',
        price: '-',
        change: '0.00',
        volume: '0',
        poolAddress: null,
        geckoPoolId: null
      })
      totalCount = 1
    } else {
      // For regular networks, fetch from DB or GeckoTerminal
      if (SUPABASE_ENABLED) {
        try {
          const result = await fetchMarketsFromDb(network, page, limit)
          if (result.data && result.data.length) {
            markets = await ensureLogos(network, result.data)
            totalCount = result.total
          }
        } catch (e) {
          console.error('[Supabase] fetch failed:', e?.message || e)
        }
      }

      if (!markets.length) {
        // Fallback to refresh + cache
        const mapped = await refreshNetwork(network, pages, duration)
        if (SUPABASE_ENABLED) {
          try {
            const result2 = await fetchMarketsFromDb(network, page, limit)
            if (result2.data && result2.data.length) {
              markets = await ensureLogos(network, result2.data)
              totalCount = result2.total
            } else {
              markets = mapped.slice((page - 1) * limit, page * limit)
              totalCount = mapped.length
            }
          } catch {
            markets = mapped.slice((page - 1) * limit, page * limit)
            totalCount = mapped.length
          }
        } else {
          markets = mapped.slice((page - 1) * limit, page * limit)
          totalCount = mapped.length
        }
      }
    }

    // Enrich with trading stats from trades table ONLY (ignore markets table price/volume/change)
    if (SUPABASE_ENABLED && markets.length) {
      try {
        // Get all recent trades for the network
        const tradesTable = network === 'crosschain' ? 'cross_chain_trades' : 'trades'
        console.log(`[markets] querying trades table: ${tradesTable} for network: ${network}`)
        let query = supabase
          .from(tradesTable)
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1000) // Get more trades for better stats
        if (network !== 'crosschain') {
          query = query.eq('network', network)
        }
        const { data: allTrades, error } = await query

        if (error) {
          console.error('[markets] trades query failed:', error?.message || error, 'table:', tradesTable, 'network:', network)
          throw error
        }

        if (!allTrades || !allTrades.length) {
          console.warn('[markets] no trades data available for stats, network:', network, 'table:', tradesTable)
        } else {
          console.log('[markets] found', allTrades.length, 'trades for network', network)
          // Group trades by pair using base_address and quote_address from trades table
          const tradesByPair = new Map()

          for (const trade of allTrades) {
            const baseAddr = (trade.base_address || '').toLowerCase()
            const quoteAddr = (trade.quote_address || '').toLowerCase()
            const pairKey = `${baseAddr}_${quoteAddr}`

            if (baseAddr && quoteAddr) {
              if (!tradesByPair.has(pairKey)) {
                tradesByPair.set(pairKey, [])
              }
              tradesByPair.get(pairKey).push(trade)
            }
          }

          // Enrich markets with stats ONLY from trades table
          const enrichedMarkets = await Promise.all(markets.map(async market => {
            const baseAddr = (market.base?.address || '').toLowerCase()
            const quoteAddr = (market.quote?.address || '').toLowerCase()
            const pairKey = `${baseAddr}_${quoteAddr}`
            const reversePairKey = `${quoteAddr}_${baseAddr}` // Check both directions

            const pairTrades = tradesByPair.get(pairKey) || tradesByPair.get(reversePairKey) || []

            console.log(`[markets] Checking pair ${baseAddr}/${quoteAddr}, found ${pairTrades.length} trades`)
            if (pairTrades.length > 0) {
              console.log(`[markets] Sample trade:`, pairTrades[0])
            }

            if (pairTrades.length === 0) {
              return { ...market, price: '-', change: '0.00', volume: '0' }
            }

            pairTrades.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

            const latestTrade = pairTrades[0]
            const baseAddrLower = baseAddr
            const quoteAddrLower = quoteAddr

            const toDec = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 255 ? n : NaN }

            let baseDecimals = toDec(market.base?.decimals)
            let quoteDecimals = toDec(market.quote?.decimals)

            if (!Number.isFinite(baseDecimals) || !Number.isFinite(quoteDecimals)) {
              try {
                // For crosschain, determine the correct network for each token
                let baseNetwork = network
                let quoteNetwork = network
                if (network === 'crosschain') {
                  baseNetwork = baseAddrLower === WBNB_ADDRESS ? 'bsc' : 'base'
                  quoteNetwork = quoteAddrLower === USDC_ADDRESS_BASE ? 'base' : 'bsc'
                }
                const [infoB, infoQ] = await Promise.all([
                  getTokenInfoCached(baseNetwork, baseAddrLower).catch(() => null),
                  getTokenInfoCached(quoteNetwork, quoteAddrLower).catch(() => null)
                ])
                if (!Number.isFinite(baseDecimals) && infoB && infoB.decimals != null) baseDecimals = toDec(infoB.decimals)
                if (!Number.isFinite(quoteDecimals) && infoQ && infoQ.decimals != null) quoteDecimals = toDec(infoQ.decimals)
              } catch {}
            }
            if (!Number.isFinite(baseDecimals)) baseDecimals = 18
            if (!Number.isFinite(quoteDecimals)) quoteDecimals = 18
            // Canonical overrides last to avoid bad DB/info values
            if (quoteAddrLower === USDC_ADDRESS_BASE) quoteDecimals = 6
            if (baseAddrLower === WETH_ADDRESS_BASE) baseDecimals = 18
            if (quoteAddrLower === WBNB_ADDRESS) quoteDecimals = 18
            if (baseAddrLower === WBNB_ADDRESS) baseDecimals = 18
            if (quoteAddrLower === USDT_ADDRESS) quoteDecimals = 18
            if (baseAddrLower === USDT_ADDRESS) baseDecimals = 18

            // Always calculate price from amounts for consistency with trade view
            const ab = Number(latestTrade.amount_base || 0)
            const aq = Number(latestTrade.amount_quote || 0)
            let currentPrice = 0
            if (ab > 0 && aq > 0) {
              currentPrice = (aq / Math.pow(10, quoteDecimals)) / (ab / Math.pow(10, baseDecimals))
            }

            // Ensure currentPrice is valid
            if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
              console.warn(`[markets] Invalid currentPrice for ${baseAddr}/${quoteAddr}: ${currentPrice}, skipping price change calculation`)
              return { ...market, price: '-', change: '0.00', volume: '0' }
            }

            const now = new Date()
            const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
            const recentTrades24h = pairTrades.filter(t => new Date(t.created_at) > oneDayAgo)
            const quoteUnit = Math.pow(10, quoteDecimals || 0)
            let volume24h = recentTrades24h.reduce((sum, t) => sum + Number(t.amount_quote || 0), 0) / quoteUnit

            // Convert volume to USD when possible
            if (quoteAddrLower === WBNB_ADDRESS) {
              const bnbPrice = await getBnbUsdPrice()
              volume24h *= bnbPrice
            } else if (quoteAddrLower === WETH_ADDRESS_BASE) {
              const ethPrice = await getEthUsdPrice()
              volume24h *= ethPrice
            } else if (quoteAddrLower === USDC_ADDRESS_BASE) {
              // already USD
            }

            let volumeDisplay = '0'
            if (volume24h > 0) {
              volumeDisplay = volume24h < 1 ? volume24h.toFixed(6) : volume24h.toLocaleString()
            }

            let priceChange = Number(market.change || '0') // Start with GeckoTerminal change as fallback
            if (recentTrades24h.length > 1) {
              // Sort by time, newest first
              recentTrades24h.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
              const latestTrade = recentTrades24h[0]
              const oldestTrade = recentTrades24h[recentTrades24h.length - 1]

              // Always calculate price from amounts for consistency
              const abLatest = Number(latestTrade.amount_base || 0)
              const aqLatest = Number(latestTrade.amount_quote || 0)
              let latestPrice = 0
              if (abLatest > 0 && aqLatest > 0) {
                latestPrice = (aqLatest / Math.pow(10, quoteDecimals)) / (abLatest / Math.pow(10, baseDecimals))
              }

              const abOldest = Number(oldestTrade.amount_base || 0)
              const aqOldest = Number(oldestTrade.amount_quote || 0)
              let oldestPrice = 0
              if (abOldest > 0 && aqOldest > 0) {
                oldestPrice = (aqOldest / Math.pow(10, quoteDecimals)) / (abOldest / Math.pow(10, baseDecimals))
              }

              if (Number.isFinite(latestPrice) && Number.isFinite(oldestPrice) && oldestPrice > 0) {
                priceChange = ((latestPrice - oldestPrice) / oldestPrice) * 100
              }
            }

            console.log(`[markets] ${baseAddr}/${quoteAddr}: found ${pairTrades.length} trades, recent24h=${recentTrades24h.length}, price=${currentPrice}, volume=${volume24h}, change=${priceChange}`)
            console.log(`[markets] Final market data for ${baseAddr}/${quoteAddr}:`, {
              price: currentPrice > 0 ? currentPrice.toFixed(8) : (market.price || '-'),
              change: Number.isFinite(priceChange) ? priceChange.toFixed(2) : '0.00',
              volume: volumeDisplay
            })

            return {
              ...market,
              price: currentPrice > 0 ? currentPrice.toFixed(8) : (market.price || '-'),
              change: Number.isFinite(priceChange) ? priceChange.toFixed(2) : '0.00',
              volume: volumeDisplay,
              volumeRaw: volume24h.toFixed(6)
            }
          }))

          markets = enrichedMarkets
        }
      } catch (statsError) {
        console.warn('[markets] failed to enrich with trading stats:', statsError?.message || statsError)
      }
    }

    // Final safety: dedupe response by pair_key as well
    const byPairFinal = new Map()
    for (const m of markets) {
      const b = (m.base?.address || '').toLowerCase()
      const q = (m.quote?.address || '').toLowerCase()
      const k = (b && q) ? (b < q ? `${b}_${q}` : `${q}_${b}`) : null
      if (!k) continue
      if (!byPairFinal.has(k)) byPairFinal.set(k, m)
    }
    const marketsFinal = Array.from(byPairFinal.values())

    console.log(`[markets] Final response for network ${network}: ${marketsFinal.length} markets`)
    if (marketsFinal.length > 0) {
      console.log(`[markets] First market sample:`, marketsFinal[0])
    }
    res.json({ network, updatedAt: Date.now(), data: marketsFinal, page, limit, total: totalCount })
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

// Force refresh on-demand
app.post('/api/markets/wbnb/refresh', async (req, res) => {
  try {
    const network = (req.query.network || 'bsc').toString()
    const pages = Number(req.query.pages || 2)
    const duration = (req.query.duration || '1h').toString()
    const mapped = await refreshNetwork(network, pages, duration)
    if (SUPABASE_ENABLED) {
      try {
        const dbRows = await fetchMarketsFromDb(network)
        const chosen = (dbRows && dbRows.length ? dbRows : mapped)
        const withLogos = await ensureLogos(network, chosen)
        return res.json({ network, updatedAt: Date.now(), data: withLogos })
      } catch {
        const withLogos = await ensureLogos(network, mapped)
        return res.json({ network, updatedAt: Date.now(), data: withLogos })
      }
    }
    return res.json({ network, updatedAt: Date.now(), data: mapped })
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

// Global 24h stats endpoint
app.get('/api/stats/global', async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(503).json({ error: 'database disabled' })

    const now = new Date()
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    // Get all trades from last 24h from both regular and cross-chain tables
    const [regularTradesResult, crossChainTradesResult] = await Promise.all([
      supabase
        .from('trades')
        .select('*')
        .gte('created_at', oneDayAgo.toISOString())
        .order('created_at', { ascending: false }),
      supabase
        .from('cross_chain_trades')
        .select('*')
        .gte('created_at', oneDayAgo.toISOString())
        .order('created_at', { ascending: false })
    ])

    if (regularTradesResult.error) throw regularTradesResult.error
    if (crossChainTradesResult.error) throw crossChainTradesResult.error

    const recentTrades = [
      ...(regularTradesResult.data || []).map(t => ({ ...t, isCrossChain: false })),
      ...(crossChainTradesResult.data || []).map(t => ({ ...t, isCrossChain: true, network: 'crosschain' }))
    ]

    if (!recentTrades || recentTrades.length === 0) {
      return res.json({
        totalVolume24h: 0,
        totalVolume24hFormatted: '$0',
        priceChange24h: 0,
        priceChange24hFormatted: '0.00%',
        totalTrades: 0,
        networks: { bsc: 0, base: 0, crosschain: 0 },
        lastUpdated: now.toISOString()
      })
    }

    let totalVolumeUSD = 0
    const networkVolumes = { bsc: 0, base: 0, crosschain: 0 }
    const networkTrades = { bsc: 0, base: 0, crosschain: 0 }

    // Group trades by pair for price change calculation
    const pairTrades = new Map()

    for (const trade of recentTrades) {
      const network = trade.network
      const pairKey = `${trade.base_address}_${trade.quote_address}`.toLowerCase()
      const amountQuote = Number(trade.amount_quote || 0)

      // Convert to USD
      let volumeUSD = amountQuote
      if (trade.quote_address.toLowerCase() === WBNB_ADDRESS) {
        const bnbPrice = await getBnbUsdPrice()
        volumeUSD = (amountQuote / Math.pow(10, 18)) * bnbPrice // WBNB has 18 decimals
      } else if (trade.quote_address.toLowerCase() === WETH_ADDRESS_BASE) {
        const ethPrice = await getEthUsdPrice()
        volumeUSD = (amountQuote / Math.pow(10, 18)) * ethPrice // WETH has 18 decimals
      } else if (trade.quote_address.toLowerCase() === USDC_ADDRESS_BASE) {
        // USDC is already USD, 6 decimals
        volumeUSD = amountQuote / Math.pow(10, 6)
      } else if (trade.quote_address.toLowerCase() === USDT_ADDRESS) {
        // USDT is stable, assume 1:1 with USD, 18 decimals
        volumeUSD = amountQuote / Math.pow(10, 18)
      }

      totalVolumeUSD += volumeUSD
      networkVolumes[network] = (networkVolumes[network] || 0) + volumeUSD
      networkTrades[network] = (networkTrades[network] || 0) + 1

      // Group by pair for price change
      if (!pairTrades.has(pairKey)) {
        pairTrades.set(pairKey, [])
      }
      pairTrades.get(pairKey).push(trade)
    }

    // Calculate global price change (weighted average of pair changes)
    let totalWeightedChange = 0
    let totalWeight = 0

    for (const [pairKey, trades] of pairTrades) {
      if (trades.length < 2) continue

      trades.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      const latestTrade = trades[0]
      const oldestTrade = trades[trades.length - 1]

      // Calculate price from amounts for consistency
      const abLatest = Number(latestTrade.amount_base || 0)
      const aqLatest = Number(latestTrade.amount_quote || 0)
      let latestPrice = 0
      if (abLatest > 0 && aqLatest > 0) {
        // Get decimals
        let baseDecimals = 18
        let quoteDecimals = 18
        const baseAddr = latestTrade.base_address.toLowerCase()
        const quoteAddr = latestTrade.quote_address.toLowerCase()
        if (baseAddr === WBNB_ADDRESS || baseAddr === WETH_ADDRESS_BASE) baseDecimals = 18
        if (quoteAddr === USDC_ADDRESS_BASE) quoteDecimals = 6
        if (quoteAddr === WBNB_ADDRESS || quoteAddr === WETH_ADDRESS_BASE || quoteAddr === USDT_ADDRESS) quoteDecimals = 18
        latestPrice = (aqLatest / Math.pow(10, quoteDecimals)) / (abLatest / Math.pow(10, baseDecimals))
      }

      const abOldest = Number(oldestTrade.amount_base || 0)
      const aqOldest = Number(oldestTrade.amount_quote || 0)
      let oldestPrice = 0
      if (abOldest > 0 && aqOldest > 0) {
        let baseDecimals = 18
        let quoteDecimals = 18
        const baseAddr = oldestTrade.base_address.toLowerCase()
        const quoteAddr = oldestTrade.quote_address.toLowerCase()
        if (baseAddr === WBNB_ADDRESS || baseAddr === WETH_ADDRESS_BASE) baseDecimals = 18
        if (quoteAddr === USDC_ADDRESS_BASE) quoteDecimals = 6
        if (quoteAddr === WBNB_ADDRESS || quoteAddr === WETH_ADDRESS_BASE || quoteAddr === USDT_ADDRESS) quoteDecimals = 18
        oldestPrice = (aqOldest / Math.pow(10, quoteDecimals)) / (abOldest / Math.pow(10, baseDecimals))
      }

      if (Number.isFinite(latestPrice) && Number.isFinite(oldestPrice) && oldestPrice > 0) {
        const pairChange = ((latestPrice - oldestPrice) / oldestPrice) * 100
        // Weight by volume in USD
        const pairVolumeUSD = trades.reduce((sum, t) => {
          const amt = Number(t.amount_quote || 0)
          let usd = amt
          const qAddr = t.quote_address.toLowerCase()
          if (qAddr === WBNB_ADDRESS) {
            const bnbPrice = 300 // approximate, or fetch
            usd = (amt / Math.pow(10, 18)) * bnbPrice
          } else if (qAddr === WETH_ADDRESS_BASE) {
            const ethPrice = 3000
            usd = (amt / Math.pow(10, 18)) * ethPrice
          } else if (qAddr === USDC_ADDRESS_BASE) {
            usd = amt / Math.pow(10, 6)
          } else if (qAddr === USDT_ADDRESS) {
            usd = amt / Math.pow(10, 18)
          }
          return sum + usd
        }, 0)
        totalWeightedChange += pairChange * pairVolumeUSD
        totalWeight += pairVolumeUSD
      }
    }

    const globalPriceChange = totalWeight > 0 ? totalWeightedChange / totalWeight : 0

    // Format volume
    const formatVolume = (vol) => {
      if (vol >= 1e9) return `$${(vol / 1e9).toFixed(2)}B`
      if (vol >= 1e6) return `$${(vol / 1e6).toFixed(2)}M`
      if (vol >= 1e3) return `$${(vol / 1e3).toFixed(2)}K`
      return `$${vol.toFixed(2)}`
    }

    return res.json({
      totalVolume24h: totalVolumeUSD,
      totalVolume24hFormatted: formatVolume(totalVolumeUSD),
      priceChange24h: globalPriceChange,
      priceChange24hFormatted: `${globalPriceChange >= 0 ? '+' : ''}${globalPriceChange.toFixed(2)}%`,
      totalTrades: recentTrades.length,
      networks: networkTrades,
      networkVolumes: {
        bsc: formatVolume(networkVolumes.bsc || 0),
        base: formatVolume(networkVolumes.base || 0),
        crosschain: formatVolume(networkVolumes.crosschain || 0)
      },
      lastUpdated: now.toISOString()
    })
  } catch (e) {
    console.error('[stats/global] error:', e?.message || e)
    res.status(500).json({ error: e?.message || String(e) })
  }
})

// Token info from DB by address
app.get('/api/token/info', async (req, res) => {
  try {
    const network = (req.query.network || 'bsc').toString()
    const address = (req.query.address || '').toString().toLowerCase()
    if (!address) return res.status(400).json({ error: 'address is required' })
    if (!SUPABASE_ENABLED) return res.status(503).json({ error: 'database disabled' })

    const { data, error } = await supabase
      .from('tokens')
      .select('*')
      .eq('network', network)
      .eq('address', address)
      .limit(1)

    if (error) throw error
    const row = (data && data[0]) || null
    if (!row) return res.status(404).json({ error: 'token not found' })

    return res.json({
      network,
      address: row.address,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      logoUrl: row.logo_url,
      updatedAt: row.updated_at
    })
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

// Proxy token logo through server to avoid hotlink/CSP issues and ensure persistence
app.get('/api/token/logo', async (req, res) => {
  try {
    const network = (req.query.network || 'bsc').toString()
    const address = (req.query.address || '').toString().toLowerCase()
    if (!address) return res.status(400).json({ error: 'address is required' })

    // 1) Try tokens table
    let logoUrl = null
    if (SUPABASE_ENABLED) {
      try {
        const { data, error } = await supabase
          .from('tokens')
          .select('logo_url')
          .eq('network', network)
          .eq('address', address)
          .limit(1)
        if (!error && data && data[0] && data[0].logo_url) logoUrl = data[0].logo_url
      } catch {}
    }

    // 2) Known logos
    if (!logoUrl && KNOWN_LOGOS[address]) logoUrl = KNOWN_LOGOS[address]

    // 3) GeckoTerminal info
    if (!logoUrl) {
      try {
        const info = await getTokenInfoCached(network, address)
        if (info?.logoUrl) logoUrl = info.logoUrl
        if (!logoUrl && info?.image_url) logoUrl = info.image_url
        // Persist discovered logo
        if (logoUrl && SUPABASE_ENABLED) {
          try {
            await supabase.from('tokens').upsert({ network, address, logo_url: logoUrl, updated_at: new Date().toISOString() }, { onConflict: 'network,address' })
          } catch {}
        }
      } catch {}
    }

    if (!logoUrl) return res.status(404).json({ error: 'logo not found' })

    // 4) Fetch and stream image
    const resp = await fetch(logoUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!resp.ok) return res.status(502).json({ error: `upstream ${resp.status}` })
    const ctype = resp.headers.get('content-type') || 'image/png'
    res.setHeader('Content-Type', ctype)
    res.setHeader('Cache-Control', 'public, max-age=86400')
    // Pipe body
    if (resp.body && resp.body.pipe) {
      resp.body.pipe(res)
    } else {
      const buf = await resp.arrayBuffer()
      res.end(Buffer.from(buf))
    }
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) })
  }
})

// ===== Orders storage (off-chain orderbook) =====
function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('hex')
}

function toLower(x) { return (x || '').toString().toLowerCase() }

function toBN(x) {
  try {
    if (typeof x === 'bigint') return x
    if (typeof x === 'number') return BigInt(Math.floor(x))
    const s = (x ?? '0').toString().trim()
    if (s === '') return 0n
    return BigInt(s)
  } catch {
    return 0n
  }
}

function minOut(amountIn, orderAmountIn, orderAmountOutMin) {
  if (orderAmountIn === 0n) return 0n
  return (amountIn * orderAmountOutMin) / orderAmountIn // floor
}

// ===== Conditional Orders =====
app.post('/api/conditional-orders', async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(503).json({ error: 'database disabled' })
    const body = req.body || {}
    const network = (body.network || 'bsc').toString()
    const maker = toLower(body.maker)
    const baseToken = toLower(body.baseToken)
    const quoteToken = toLower(body.quoteToken)
    const type = (body.type || '').toString()
    const triggerPrice = (body.triggerPrice || '').toString()
    const orderTemplate = body.orderTemplate || {}
    const signature = (body.signature || '').toString()
    const expiration = body.expiration ? new Date(body.expiration).toISOString() : null

    // Validations
    if (!maker || !baseToken || !quoteToken || !type || !triggerPrice || !orderTemplate || !signature) {
      return res.status(400).json({ error: 'maker, baseToken, quoteToken, type, triggerPrice, orderTemplate, and signature required' })
    }
    if (!['stop_loss', 'take_profit'].includes(type)) {
      return res.status(400).json({ error: 'type must be stop_loss or take_profit' })
    }
    if (isNaN(Number(triggerPrice))) {
      return res.status(400).json({ error: 'triggerPrice must be a valid number' })
    }

    // Generate ID
    const conditionalOrderId = crypto.randomUUID()

    const row = {
      network,
      conditional_order_id: conditionalOrderId,
      maker,
      base_token: baseToken,
      quote_token: quoteToken,
      pair: `${baseToken}/${quoteToken}`,
      type,
      trigger_price: triggerPrice,
      order_template: orderTemplate,
      signature,
      expiration,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    const { error } = await supabase.from('conditional_orders').insert(row)
    if (error) throw error
    return res.json({ ok: true, id: conditionalOrderId })
  } catch (e) {
    console.error('[conditional-orders] create error:', e?.message || e)
    return res.status(500).json({ error: e?.message || String(e) })
  }
})

app.get('/api/conditional-orders', async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(503).json({ error: 'database disabled' })
    const network = (req.query.network || 'bsc').toString()
    const maker = toLower(req.query.maker)
    const status = (req.query.status || '').toString()

    let query = supabase
      .from('conditional_orders')
      .select('*')
      .eq('network', network)
      .order('created_at', { ascending: false })

    if (maker) query = query.eq('maker', maker)
    if (status) query = query.eq('status', status)

    const { data, error } = await query
    if (error) throw error

    return res.json({ network, data: data || [] })
  } catch (e) {
    console.error('[conditional-orders] list error:', e?.message || e)
    return res.status(500).json({ error: e?.message || String(e) })
  }
})

app.post('/api/conditional-orders/cancel', async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(503).json({ error: 'database disabled' })
    const { id, network } = req.body || {}
    if (!id || !network) return res.status(400).json({ error: 'id and network required' })

    const { error } = await supabase
      .from('conditional_orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('conditional_order_id', id)
      .eq('network', network)
      .limit(1)

    if (error) throw error
    return res.json({ ok: true })
  } catch (e) {
    console.error('[conditional-orders/cancel] error:', e?.message || e)
    return res.status(500).json({ error: e?.message || String(e) })
  }
})

app.post('/api/orders/cancel', async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(503).json({ error: 'database disabled' })
    const { orderId, network } = req.body || {}
    if (!orderId || !network) return res.status(400).json({ error: 'orderId and network required' })

    const tableName = network === 'crosschain' ? 'cross_chain_orders' : 'orders'
    const { error } = await supabase
      .from(tableName)
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('order_id', orderId)
      .eq('network', network)
      .limit(1)

    if (error) throw error
    return res.json({ ok: true })
  } catch (e) {
    console.error('[orders/cancel] error:', e?.message || e)
    return res.status(500).json({ error: e?.message || String(e) })
  }
})

app.post('/api/orders/lookup', async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(503).json({ error: 'database disabled' })
    const { network, maker, tokenIn, tokenOut, nonce, salt } = req.body || {}
    if (!network || !maker || !tokenIn || !tokenOut || nonce == null || salt == null) {
      return res.status(400).json({ error: 'network, maker, tokenIn, tokenOut, nonce, and salt required' })
    }

    const tableName = network === 'crosschain' ? 'cross_chain_orders' : 'orders'
    const { data, error } = await supabase
      .from(tableName)
      .select('order_id')
      .eq('network', network)
      .eq('maker', toLower(maker))
      .eq('token_in', toLower(tokenIn))
      .eq('token_out', toLower(tokenOut))
      .eq('nonce', String(nonce))
      .eq('salt', String(salt))
      .limit(1)

    if (error) throw error

    if (data && data.length > 0) {
      return res.json({ orderId: data[0].order_id })
    } else {
      return res.status(404).json({ error: 'order not found' })
    }
  } catch (e) {
    console.error('[orders/lookup] error:', e?.message || e)
    return res.status(500).json({ error: e?.message || String(e) })
  }
})

function classifyOrder(base, quote, order, tokenInDec, tokenOutDec) {
  const baseL = toLower(base), quoteL = toLower(quote)
  const tokenIn = toLower(order?.tokenIn), tokenOut = toLower(order?.tokenOut)
  if (!baseL || !quoteL || !tokenIn || !tokenOut) return { side: null, price: null }
  const amountIn = BigInt(order.amountIn || 0n)
  const amountOutMin = BigInt(order.amountOutMin || 0n)
  if (amountIn === 0n) return { side: null, price: null }
  // ask: selling base for quote
  if (tokenIn === baseL && tokenOut === quoteL) {
    const price = Number(amountOutMin) / 10**tokenOutDec / (Number(amountIn) / 10**tokenInDec)
    return { side: 'ask', price }
  }
  // bid: selling quote for base
  if (tokenIn === quoteL && tokenOut === baseL) {
    const price = Number(amountIn) / 10**tokenInDec / (Number(amountOutMin) / 10**tokenOutDec)
    return { side: 'bid', price }
  }
  return { side: null, price: null }
}

app.post('/api/orders', async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(503).json({ error: 'database disabled' })
    const body = req.body || {}
    const network = (body.network || 'bsc').toString()
    const order = body.order || {}
    const signature = (body.signature || '').toString()
    const base = toLower(body.base)
    const quote = toLower(body.quote)
    if (!base || !quote) return res.status(400).json({ error: 'base and quote required' })

    // Basic validations
    if (!order.maker || !order.tokenIn || !order.tokenOut) return res.status(400).json({ error: 'missing order fields' })
    const now = Math.floor(Date.now() / 1000)
    if (order.expiration && Number(order.expiration) !== 0 && Number(order.expiration) < now) return res.status(400).json({ error: 'expired' })

    // Enforce no native BNB pairs
    const bSym = (body.baseSymbol || '').toUpperCase()
    const qSym = (body.quoteSymbol || '').toUpperCase()
    if (bSym === 'BNB' || qSym === 'BNB') return res.status(400).json({ error: 'BNB pairs not accepted' })

    // Get decimals for tokens
    let tokenInDec = 18, tokenOutDec = 18
    try {
      const addresses = [order.tokenIn.toLowerCase(), order.tokenOut.toLowerCase()]
      const { data: t } = await supabase
        .from('tokens')
        .select('address, decimals')
        .in('network', ['bsc', 'base'])
        .in('address', addresses)
      if (t) {
        for (const row of t) {
          const addr = row.address.toLowerCase()
          if (addr === order.tokenIn.toLowerCase()) tokenInDec = row.decimals || 18
          if (addr === order.tokenOut.toLowerCase()) tokenOutDec = row.decimals || 18
        }
      }
    } catch {}
    // Hardcode known decimals
    const tokenInLower = order.tokenIn.toLowerCase()
    const tokenOutLower = order.tokenOut.toLowerCase()
    if (tokenInLower === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c') tokenInDec = 18
    if (tokenOutLower === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c') tokenOutDec = 18
    if (tokenInLower === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913') tokenInDec = 6
    if (tokenOutLower === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913') tokenOutDec = 6
    // Additional known tokens
    if (tokenInLower === '0x55d398326f99059ff775485246999027b3197955') tokenInDec = 18 // USDT BSC
    if (tokenOutLower === '0x55d398326f99059ff775485246999027b3197955') tokenOutDec = 18
    if (tokenInLower === '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d') tokenInDec = 18 // USDT BSC alt?
    if (tokenOutLower === '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d') tokenOutDec = 18
    if (tokenInLower === '0x4200000000000000000000000000000000000006') tokenInDec = 18 // WETH Base
    if (tokenOutLower === '0x4200000000000000000000000000000000000006') tokenOutDec = 18

    const { side, price } = classifyOrder(base, quote, order, tokenInDec, tokenOutDec)

    const orderId = crypto.randomUUID()
    const orderHash = sha1(JSON.stringify({ network, maker: toLower(order.maker), nonce: String(order.nonce || ''), tokenIn: toLower(order.tokenIn), tokenOut: toLower(order.tokenOut), salt: String(order.salt || '') }))
    const remaining = String(order.amountIn || '0')

    const row = {
      network,
      order_id: orderId,
      order_hash: orderHash,
      maker: toLower(order.maker),
      token_in: toLower(order.tokenIn),
      token_out: toLower(order.tokenOut),
      amount_in: String(order.amountIn || '0'),
      amount_out_min: String(order.amountOutMin || '0'),
      expiration: order.expiration ? new Date(Number(order.expiration) * 1000).toISOString() : null,
      nonce: String(order.nonce || '0'),
      receiver: toLower(order.receiver || ''),
      salt: String(order.salt || '0'),
      signature,
      order_json: order,
      base,
      quote,
      base_address: base || null,
      quote_address: quote || null,
      pair: base && quote ? `${base}/${quote}` : null,
      side: null,
      price: price != null ? String(price) : null,
      remaining,
      status: 'open',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    // Use different table for cross-chain orders
    const tableName = network === 'crosschain' ? 'cross_chain_orders' : 'orders'

    try {
      const { error } = await supabase.from(tableName).upsert(row, { onConflict: 'network,order_id' })
      if (error) throw error
      return res.json({ ok: true, id: orderId })
    } catch (e1) {
      console.error(`[${tableName}] upsert failed:`, e1?.message || e1)
      // Fallback 1: simple insert (in case unique index is missing)
      try {
        const { error: eIns } = await supabase.from(tableName).insert(row)
        if (eIns) throw eIns
        return res.json({ ok: true, id: orderId })
      } catch (e2) {
        console.error(`[${tableName}] insert failed:`, e2?.message || e2)
        // Fallback 2: insert minimal columns only to bypass missing columns
        try {
          const minimal = {
            network,
            order_id: orderId,
            order_hash: orderHash,
            base,
            quote,
            maker: toLower(order.maker),
            token_in: toLower(order.tokenIn),
            token_out: toLower(order.tokenOut),
            amount_in: String(order.amountIn || '0'),
            amount_out_min: String(order.amountOutMin || '0'),
            remaining,
            status: 'open',
            updated_at: new Date().toISOString()
          }
          const { error: eMin } = await supabase.from(tableName).insert(minimal)
          if (eMin) throw eMin
          return res.json({ ok: true, id: orderId, note: 'stored minimal' })
        } catch (e3) {
          console.error(`[${tableName}] minimal insert failed:`, e3?.message || e3)
          return res.status(500).json({ error: e3?.message || String(e3) })
        }
      }
    }
  } catch (e) {
    console.error('[orders] handler error:', e?.message || e)
    return res.status(500).json({ error: e?.message || String(e) })
  }
})

app.get('/api/orders', async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(503).json({ error: 'database disabled' })
    const network = (req.query.network || 'bsc').toString()
    const base = toLower(req.query.base)
    const quote = toLower(req.query.quote)
    const maker = toLower(req.query.maker)
    const status = (req.query.status || '').toString()

    // If maker and status are provided, fetch user's orders
    if (maker && status) {
      const nowIso = new Date().toISOString()
      const tableName = network === 'crosschain' ? 'cross_chain_orders' : 'orders'
      let query = supabase
        .from(tableName)
        .select('*')
        .eq('maker', maker)
        .eq('status', status)

      const { data, error } = await query
      if (error) throw error
      const rows = (data || []).filter(r => !r.expiration || r.expiration > nowIso)

      // Convert to order objects
      const orders = rows.map(r => ({
        maker: r.maker,
        tokenIn: r.token_in,
        tokenOut: r.token_out,
        amountIn: r.amount_in,
        amountOutMin: r.amount_out_min,
        expiration: r.expiration,
        nonce: r.nonce,
        receiver: r.receiver,
        salt: r.salt,
        signature: r.signature
      }))

      return res.json({ network, maker, status, data: orders })
    }

    // Original orderbook logic
    if (!base || !quote) return res.status(400).json({ error: 'base and quote required' })

    const nowIso = new Date().toISOString()
    const tableName = network === 'crosschain' ? 'cross_chain_orders' : 'orders'
    let rows = []
    if (SUPABASE_ENABLED) {
      try {
        const { data, error } = await supabase
          .from(tableName)
          .select('*')
          .eq('base_address', base)
          .eq('quote_address', quote)
          .eq('status', 'open')
          .gt('remaining', '0')
          .order('price', { ascending: true }) // Sort by price for efficient limiting
          .limit(100) // Fetch more than needed to allow sorting and limiting
        if (error) throw error
        rows = (data || []).filter(r => !r.expiration || r.expiration > nowIso)
      } catch (dbErr) {
        console.warn('[orders] db fetch failed:', dbErr?.message || dbErr)
        return res.status(500).json({ error: dbErr?.message || String(dbErr) })
      }
    }

    const asks = []
    const bids = []
    for (const r of rows) {
      const side = (toLower(r.token_in) === base && toLower(r.token_out) === quote) ? 'ask' : (toLower(r.token_in) === quote && toLower(r.token_out) === base ? 'bid' : null)
      const price = r.price != null ? Number(r.price) : (side === 'ask' ? Number(r.amount_out_min) / Number(r.amount_in) : (Number(r.amount_in) / Number(r.amount_out_min || 1)))
      const rec = { id: r.order_id, maker: r.maker, price, amountIn: r.remaining, tokenIn: r.token_in, tokenOut: r.token_out }
      if (side === 'ask') asks.push(rec)
      else if (side === 'bid') bids.push(rec)
    }

    asks.sort((a, b) => a.price - b.price)  // lowest ask first
    bids.sort((a, b) => b.price - a.price)  // highest bid first

    // Return individual orders instead of aggregating by price level
    // Limit to top 50 orders per side for performance
    const limitedAsks = asks.slice(0, 50)
    const limitedBids = bids.slice(0, 50)

    return res.json({ base, quote, asks: limitedAsks, bids: limitedBids, updatedAt: Date.now() })
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) })
  }
})

// Fatal error handlers to surface early exits
process.on('unhandledRejection', (reason) => {
  try { console.error('[fatal] unhandledRejection:', reason) } catch {}
})
process.on('uncaughtException', (err) => {
  try { console.error('[fatal] uncaughtException:', err) } catch {}
})

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log(`Indexer server listening on http://localhost:${PORT}`)
})
server.on('error', (err) => {
  console.error('[server] listen error:', err?.code || err?.message || err)
  if (err?.code === 'EADDRINUSE') {
    console.error(`[server] Port ${PORT} is already in use. Set a different PORT in .env or stop the conflicting process.`)
  }
})

// Start on-chain executor in background
try {
  await import('./executor.js')
  console.log('[executor] module loaded')
} catch (e) {
  console.warn('[executor] failed to load:', e?.message || e)
}
