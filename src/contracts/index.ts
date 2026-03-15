import type { CangeResolvedConfig } from "../client/config.js";
import type { CangeClient } from "../client/http.js";

import { createAttachmentsContracts } from "./attachments.js";
import { createCardsContracts } from "./cards.js";
import { createCommentsContracts } from "./comments.js";
import { createDiscoveryContracts } from "./discovery.js";
import { createFieldsContracts } from "./fields.js";
import { createFlowsContracts } from "./flows.js";
import { createPayloadBuilderContracts } from "./payload-builder.js";
import { createRegistersContracts } from "./registers.js";

export function createContracts(params: { client: CangeClient; config: CangeResolvedConfig }) {
  const discovery = createDiscoveryContracts(params);
  const flows = createFlowsContracts(params.client);
  const fields = createFieldsContracts(params.client);
  const cards = createCardsContracts(params.client);
  const comments = createCommentsContracts(params.client);
  const attachments = createAttachmentsContracts(params.client);
  const registers = createRegistersContracts(params.client);
  const payloadBuilder = createPayloadBuilderContracts({
    flows,
    fields,
    registers
  });

  const readOnly = {
    getMyFlows: discovery.getMyFlows,
    getMyRegisters: discovery.getMyRegisters,
    getFlow: flows.getFlow,
    getRegister: registers.getRegister,
    getFieldsByFlow: fields.getFieldsByFlow,
    getFieldsByRegister: fields.getFieldsByRegister,
    getFlowInitFormFields: payloadBuilder.getFlowInitFormFields,
    getRegisterFormFields: payloadBuilder.getRegisterFormFields,
    getRequiredFlowFields: payloadBuilder.getRequiredFlowFields,
    getRequiredRegisterFields: payloadBuilder.getRequiredRegisterFields,
    buildCardCreationTemplate: payloadBuilder.buildCardCreationTemplate,
    buildRegisterCreationTemplate: payloadBuilder.buildRegisterCreationTemplate,
    validateValuesAgainstFields: payloadBuilder.validateValuesAgainstFields,
    getCard: cards.getCard,
    listCardsByFlow: cards.listCardsByFlow,
    getRegisterFormAnswer: registers.getRegisterFormAnswer
  };

  const mutations = {
    createCard: cards.createCard,
    updateCard: cards.updateCard,
    updateCardValues: cards.updateCardValues,
    createCardComment: comments.createCardComment,
    uploadAttachment: attachments.uploadAttachment,
    linkAttachmentToCard: attachments.linkAttachmentToCard,
    createRegister: registers.createRegister,
    updateRegister: registers.updateRegister
  };

  return {
    authenticate: discovery.authenticate,
    ...readOnly,
    ...mutations,
    readOnly,
    mutations
  };
}

export type CangeContracts = ReturnType<typeof createContracts>;
