import type { CangeResolvedConfig } from "../client/config.js";
import type { CangeClient } from "../client/http.js";

import { createAttachmentsContracts } from "./attachments.js";
import { createCardsContracts } from "./cards.js";
import { createCommentsContracts } from "./comments.js";
import { createDiscoveryContracts } from "./discovery.js";
import { createFieldsContracts } from "./fields.js";
import { createFlowCardsContracts } from "./flowCards.js";
import { createFlowQueryContracts } from "./flowQuery.js";
import { createFlowV2BuildContracts } from "./flowV2Build.js";
import { createFlowViewsContracts } from "./flowViews.js";
import { createFlowsContracts } from "./flows.js";
import { createNotificationsContracts } from "./notifications.js";
import { createPayloadBuilderContracts } from "./payload-builder.js";
import { createRegisterQueryContracts } from "./registerQuery.js";
import { createRegistersContracts } from "./registers.js";
import { createTimeTrackingContracts } from "./timeTracking.js";

export function createContracts(params: { client: CangeClient; config: CangeResolvedConfig }) {
  const discovery = createDiscoveryContracts(params);
  const flows = createFlowsContracts(params.client);
  const fields = createFieldsContracts(params.client);
  const cards = createCardsContracts(params.client);
  const comments = createCommentsContracts(params.client);
  const notifications = createNotificationsContracts(params.client);
  const attachments = createAttachmentsContracts(params.client);
  const registers = createRegistersContracts(params.client);
  const registerQuery = createRegisterQueryContracts({ client: params.client, fields });
  const timeTracking = createTimeTrackingContracts(params.client);
  const flowV2Build = createFlowV2BuildContracts(params.client);
  const flowQuery = createFlowQueryContracts(params.client);
  const flowViews = createFlowViewsContracts(params.client);
  const flowCards = createFlowCardsContracts({ cards, flows, flowQuery });
  const payloadBuilder = createPayloadBuilderContracts({
    flows,
    fields,
    registers
  });

  const readOnly = {
    getMyFlows: discovery.getMyFlows,
    getMyRegisters: discovery.getMyRegisters,
    getMyTasks: discovery.getMyTasks,
    getNotificationsByUser: discovery.getNotificationsByUser,
    getFlow: flows.getFlow,
    getRegister: registers.getRegister,
    getRegisterEntries: registerQuery.getRegisterEntries,
    getRegisterEngineStatus: registerQuery.getRegisterEngineStatus,
    getFieldsByFlow: fields.getFieldsByFlow,
    getFieldsByRegister: fields.getFieldsByRegister,
    getFlowInitFormFields: payloadBuilder.getFlowInitFormFields,
    getFlowStepFormFields: payloadBuilder.getFlowStepFormFields,
    getRegisterFormFields: payloadBuilder.getRegisterFormFields,
    getRequiredFlowFields: payloadBuilder.getRequiredFlowFields,
    getRequiredFlowStepFields: payloadBuilder.getRequiredFlowStepFields,
    getRequiredRegisterFields: payloadBuilder.getRequiredRegisterFields,
    buildCardCreationTemplate: payloadBuilder.buildCardCreationTemplate,
    buildCardStepMoveTemplate: payloadBuilder.buildCardStepMoveTemplate,
    buildRegisterCreationTemplate: payloadBuilder.buildRegisterCreationTemplate,
    validateValuesAgainstFields: payloadBuilder.validateValuesAgainstFields,
    getCard: cards.getCard,
    listCardsByFlow: cards.listCardsByFlow,
    fetchFlowCards: flowCards.fetchFlowCards,
    resolveQueryEngine: flowCards.resolveQueryEngine,
    queryFlowV2: flowQuery.queryFlowV2,
    queryFlowV2All: flowQuery.queryFlowV2All,
    getQueryEngineStatus: flowQuery.getQueryEngineStatus,
    listFlowViews: flowViews.listFlowViews,
    getFlowView: flowViews.getFlowView,
    getCardRelationship: cards.getCardRelationship,
    getCardAttachmentDownloads: attachments.getCardAttachmentDownloads,
    getRegisterFormAnswer: registers.getRegisterFormAnswer,
    listCommentsByCard: comments.listCommentsByCard,
    flowBuildPing: flowV2Build.ping,
    listFlowBuildFieldTypes: flowV2Build.listFieldTypes,
    getFlowBuildFieldTypeDescriptor: flowV2Build.getFieldTypeDescriptor,
    listFlowBuildStepRelationshipsByFlow: flowV2Build.listStepRelationshipsByFlow,
    listFlowBuildStepRelationshipsFromStep: flowV2Build.listStepRelationshipsFromStep
  };

  const mutations = {
    createCard: cards.createCard,
    updateCard: cards.updateCard,
    updateCardValues: cards.updateCardValues,
    moveCardStep: cards.moveCardStep,
    moveCardStepWithValues: cards.moveCardStepWithValues,
    addCardLabel: cards.addCardLabel,
    addChildCard: cards.addChildCard,
    readNotification: notifications.readNotification,
    createCardComment: comments.createCardComment,
    uploadAttachment: attachments.uploadAttachment,
    linkAttachmentToCard: attachments.linkAttachmentToCard,
    createRegister: registers.createRegister,
    updateRegister: registers.updateRegister,
    createTimeTracking: timeTracking.createTimeTracking,
    createFlowBuildFlow: flowV2Build.createFlow,
    updateFlowBuildFlow: flowV2Build.updateFlow,
    createFlowBuildStep: flowV2Build.createStep,
    updateFlowBuildStep: flowV2Build.updateStep,
    reorderFlowBuildStep: flowV2Build.reorderStep,
    createFlowBuildFieldByStep: flowV2Build.createFieldByStep,
    createFlowBuildFieldByForm: flowV2Build.createFieldByForm,
    patchFlowBuildFieldByFlow: flowV2Build.patchFieldByFlow,
    patchFlowBuildFieldByStep: flowV2Build.patchFieldByStep,
    patchFlowBuildFieldByForm: flowV2Build.patchFieldByForm,
    deleteFlowBuildFieldByFlow: flowV2Build.deleteFieldByFlow,
    deleteFlowBuildFieldByStep: flowV2Build.deleteFieldByStep,
    upsertFlowBuildStepRelationship: flowV2Build.upsertStepRelationship
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
