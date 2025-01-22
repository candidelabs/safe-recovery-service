import { ethers, utils } from "ethers";

const MAGIC_VALUE = '0x1626ba7e'
const MAGIC_VALUE_BYTES = '0x20c13b0b'

export const isValidSignature = async (
  signerAddress: string,
  message: Uint8Array,
  signature: Uint8Array,
  provider: ethers.providers.JsonRpcProvider
) => {

  if (!utils.getAddress(signerAddress)) {
    throw new Error('Invalid signer address')
  }

  const msgBytes = message
  const bytecode = await provider.getCode(signerAddress)

  if (
    !bytecode ||
    bytecode === '0x' ||
    bytecode === '0x0' ||
    bytecode === '0x00'
  ) {
    const msgSigner = utils.recoverAddress(msgBytes, signature)
    return msgSigner.toLowerCase() === signerAddress.toLowerCase()
  } else {

    if (await check1271Signature(signerAddress, msgBytes, signature, provider))
      return true

    return await check1271SignatureBytes(
      signerAddress,
      msgBytes,
      signature,
      provider
    );

  }
}

const check1271Signature = async (
  signerAddress: string,
  msgBytes: Uint8Array,
  signature: Uint8Array,
  provider: ethers.providers.JsonRpcProvider
) => {
  const fragment = ethers.utils.FunctionFragment.from({
    constant: true,
    inputs: [
      {
        name: 'message',
        type: 'bytes32'
      },
      {
        name: 'signature',
        type: 'bytes'
      }
    ],
    name: 'isValidSignature',
    outputs: [
      {
        name: 'magicValue',
        type: 'bytes4'
      }
    ],
    payable: false,
    stateMutability: 'view',
    type: 'function'
  })
  const ifc = new ethers.utils.Interface([])

  // Convert message to ETH signed message hash and call valid_signature
  try {
    const msgHash = utils.hashMessage(msgBytes)
    const isValidSignatureData = ifc.encodeFunctionData(fragment, [msgHash, signature])
    const returnValue = (
      await provider.call({
        to: signerAddress,
        data: isValidSignatureData
      })
    ).slice(0, 10)
    if (returnValue.toLowerCase() === MAGIC_VALUE) return true
    // eslint-disable-next-line no-empty
  } catch (err) {}

  // If the message is a 32 bytes, try without any conversion
  if (msgBytes.length === 32) {
    try {
      const isValidSignatureData = ifc.encodeFunctionData(fragment, [
        msgBytes,
        signature
      ])
      const returnValue = (
        await provider.call({
          to: signerAddress,
          data: isValidSignatureData
        })
      ).slice(0, 10)
      if (returnValue.toLowerCase() === MAGIC_VALUE) return true
      // eslint-disable-next-line no-empty
    } catch (err) {}
  }

  // Try taking a regular hash of the message
  try {
    const msgHash = utils.keccak256(msgBytes)
    const isValidSignatureData = ifc.encodeFunctionData(fragment, [
      msgHash,
      signature
    ])
    const returnValue = (
      await provider.call({
        to: signerAddress,
        data: isValidSignatureData
      })
    ).slice(0, 10)
    if (returnValue.toLowerCase() === MAGIC_VALUE) return true
    // eslint-disable-next-line no-empty
  } catch (err) {}

  return false
}

const check1271SignatureBytes = async (
  signerAddress: string,
  msgBytes: Uint8Array,
  signature: Uint8Array,
  provider: ethers.providers.JsonRpcProvider
) => {
  const fragment = ethers.utils.FunctionFragment.from({
    constant: true,
    inputs: [
      {
        name: 'message',
        type: 'bytes'
      },
      {
        name: 'signature',
        type: 'bytes'
      }
    ],
    name: 'isValidSignature',
    outputs: [
      {
        name: 'magicValue',
        type: 'bytes4'
      }
    ],
    payable: false,
    stateMutability: 'view',
    type: 'function'
  })
  const ifc = new ethers.utils.Interface([])

  try {
    const isValidSignatureData = ifc.encodeFunctionData(fragment, [
      msgBytes,
      signature
    ])
    const returnValue = (
      await provider.call({
        to: signerAddress,
        data: isValidSignatureData
      })
    ).slice(0, 10)
    if (returnValue.toLowerCase() === MAGIC_VALUE_BYTES) return true
    // eslint-disable-next-line no-empty
  } catch (err) {}

  return false
}