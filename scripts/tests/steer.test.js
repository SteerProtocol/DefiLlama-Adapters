const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { Interface } = require('ethers')

const native = '0x0000000000000000000000000000000000000000'
const token = '0x078d782b760474a361dda0af3839290b0ef57ad6'
const vault = '0x14aa002cf2d27717b8a6e071cd6de9f69213e080'
const metadataAbi = new Interface([
  'function uniswapV4VaultMetadataByAddress(address) view returns ((string beaconType, address currency0, address currency1, string vaultName, string vaultSymbol, uint8 vaultDecimals, string token0Name, string token1Name, string token0Symbol, string token1Symbol, uint8 token0Decimals, uint8 token1Decimals, address vault) meta)',
])
const bytesAbi = new Interface([
  'function uniswapV4VaultMetadataByAddress(address) view returns (bytes metadata)',
])

// Decode a real tuple-encoded return value using the adapter's current ABI.
function metadata(currency0, currency1) {
  const raw = metadataAbi.encodeFunctionResult('uniswapV4VaultMetadataByAddress', [[
    'UniswapV4Hook', currency0, currency1, 'Vault', 'VAULT', 18,
    'Native', 'USDC', 'NATIVE', 'USDC', 18, 6, vault,
  ]])
  return bytesAbi.decodeFunctionResult('uniswapV4VaultMetadataByAddress', raw)[0]
}

async function getBalances({ currency0 = native, currency1 = token, balances = { bal0: '100', bal1: '200' }, snapshot = {}, metadataFails = false } = {}) {
  const source = readFileSync(path.join(__dirname, '../../projects/steer/index.js'), 'utf8')
  const context = {
    module: { exports: {} },
    console,
    require(name) {
      if (name === '@defillama/sdk') return {}
      if (name === '../helper/coreAssets.json') return { null: native }
      if (name === '../helper/staking') return { stakings: () => () => ({}) }
      if (name === '../helper/cache') return {
        cachedGraphQuery: async () => [{
          id: vault, beaconName: 'UniswapV4Hook', token0: '', token1: '',
          token0Balance: '0', token1Balance: '0', ...snapshot,
        }],
      }
      throw new Error(`Unexpected dependency ${name}`)
    },
  }
  vm.runInNewContext(source, context)
  const totals = {}
  const api = {
    chain: 'unichain',
    multiCall: async ({ abi }) => {
      if (abi.includes('uniswapV4VaultBalancesByAddress')) return [balances]
      if (abi.includes('uniswapV4VaultMetadataByAddress')) return [metadataFails ? null : metadata(currency0, currency1)]
      // V4 currencies are exposed through poolKey, not legacy token getters.
      if (abi === 'address:token0' || abi === 'address:token1') return [null]
      throw new Error(`Unexpected ABI ${abi}`)
    },
    add(address, amount) { totals[address.toLowerCase()] = String(BigInt(totals[address.toLowerCase()] ?? '0') + BigInt(amount)) },
    getBalances: () => totals,
  }
  return context.module.exports.unichain.tvl(api)
}

test('counts both live balances of a native pair with empty subgraph token fields', async () => {
  assert.deepEqual(await getBalances(), { [native]: '100', [token]: '200' })
})

test('prefers live native-pair balances over stale snapshots', async () => {
  assert.deepEqual(await getBalances({ snapshot: {
    token0: native, token1: token, token0Balance: '900', token1Balance: '800',
  } }), { [native]: '100', [token]: '200' })
})

test('keeps a live zero balance instead of using a stale native snapshot', async () => {
  assert.deepEqual(await getBalances({
    balances: { bal0: '0', bal1: '200' },
    snapshot: { token0: native, token1: token, token0Balance: '900', token1Balance: '800' },
  }), { [native]: '0', [token]: '200' })
})

test('continues to count ERC20 pairs from metadata', async () => {
  const otherToken = '0x55d398326f99059ff775485246999027b3197955'
  assert.deepEqual(await getBalances({ currency0: otherToken }), { [otherToken]: '100', [token]: '200' })
})

test('uses the existing snapshot fallback when a balance read fails', async () => {
  assert.deepEqual(await getBalances({ balances: null, snapshot: {
    token0: native, token1: token, token0Balance: '900', token1Balance: '800',
  } }), { [native]: '900', [token]: '800' })
})

test('uses the existing snapshot fallback when currency metadata is unavailable', async () => {
  assert.deepEqual(await getBalances({ metadataFails: true, snapshot: {
    token0: native, token1: token, token0Balance: '900', token1Balance: '800',
  } }), { [native]: '900', [token]: '800' })
})
