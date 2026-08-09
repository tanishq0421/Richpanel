# backend/app/api/v1/schedules/router.py
from fastapi import APIRouter, Depends, status

from app.api.v1.schedules.request_response import (
    DeletionImpactResponse,
    ScheduleCreateRequest,
    ScheduleResponse,
    ScheduleUpdateRequest,
    ShiftInputSchema,
)
from app.services import schedule_service
from app.shared.pagination import PaginationParams

router = APIRouter(prefix="/api/v1/schedules", tags=["schedules"])


def _to_response(detail: schedule_service.ScheduleDetail) -> ScheduleResponse:
    return ScheduleResponse(
        id=detail.id,
        name=detail.name,
        start_date=detail.start_date,
        end_date=detail.end_date,
        shifts=[ShiftInputSchema.from_domain(s) for s in detail.shifts],
    )


@router.post("", response_model=ScheduleResponse, status_code=status.HTTP_201_CREATED)
def create_schedule(request: ScheduleCreateRequest):
    detail = schedule_service.create_schedule(
        name=request.name,
        start_date=request.start_date,
        end_date=request.end_date,
        shift_inputs=[s.to_domain() for s in request.shifts],
    )
    return _to_response(detail)


@router.get("", response_model=list[ScheduleResponse])
def list_schedules(pagination: PaginationParams = Depends()):
    details = schedule_service.list_schedules(pagination.limit, pagination.offset)
    return [_to_response(d) for d in details]


@router.get("/{schedule_id}", response_model=ScheduleResponse)
def get_schedule(schedule_id: int):
    return _to_response(schedule_service.get_schedule_detail(schedule_id))


@router.put("/{schedule_id}", response_model=ScheduleResponse)
def update_schedule(schedule_id: int, request: ScheduleUpdateRequest):
    detail = schedule_service.update_schedule_hours(schedule_id, [s.to_domain() for s in request.shifts])
    return _to_response(detail)


@router.get("/{schedule_id}/deletion-impact", response_model=DeletionImpactResponse)
def get_deletion_impact(schedule_id: int):
    impact = schedule_service.get_deletion_impact(schedule_id)
    return DeletionImpactResponse(schedule_id=impact.schedule_id, affected_agent_ids=impact.affected_agent_ids)


@router.delete("/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_schedule(schedule_id: int):
    schedule_service.soft_delete_schedule(schedule_id)
